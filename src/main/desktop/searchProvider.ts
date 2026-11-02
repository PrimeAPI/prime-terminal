// GNOME Shell search provider: shows saved servers as results of the Prime Terminal app in the
// GNOME search. Implemented as a tiny D-Bus-activated Python script (python3-gi ships with GNOME),
// so searching never has to start Electron. It reads servers.json on every query.

import { APP_ID } from './entries'

export const SEARCH_BUS_NAME = 'dev.primeterminal.SearchProvider'
export const SEARCH_OBJECT_PATH = '/dev/primeterminal/SearchProvider'
export const SEARCH_INI_NAME = `${APP_ID}.search-provider.ini`

export function searchProviderIni(): string {
  return [
    '[Shell Search Provider]',
    `DesktopId=${APP_ID}.desktop`,
    `BusName=${SEARCH_BUS_NAME}`,
    `ObjectPath=${SEARCH_OBJECT_PATH}`,
    'Version=2',
    ''
  ].join('\n')
}

export function searchProviderService(python: string, script: string): string {
  return ['[D-BUS Service]', `Name=${SEARCH_BUS_NAME}`, `Exec=${python} ${script}`, ''].join('\n')
}

/** Picks a directory from GNOME Shell's XDG_DATA_DIRS that lives in the user's home and is writable. */
export function userSearchProviderBase(dataDirs: string[], home: string, writable: (dir: string) => boolean): string | null {
  for (const raw of dataDirs) {
    const dir = raw.replace(/\/+$/, '')
    if (!dir || !(dir === home || dir.startsWith(home + '/'))) continue
    if (writable(dir)) return dir
  }
  return null
}

export function searchProviderScript(opts: { serversFile: string; command: string[] }): string {
  return `#!/usr/bin/env python3
# Prime Terminal – GNOME Shell search provider (generated, do not edit)
import json, subprocess
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

SERVERS_FILE = ${JSON.stringify(opts.serversFile)}
COMMAND = ${JSON.stringify(opts.command)}
BUS_NAME = ${JSON.stringify(SEARCH_BUS_NAME)}
OBJECT_PATH = ${JSON.stringify(SEARCH_OBJECT_PATH)}
ICON = ${JSON.stringify(APP_ID)}
IDLE_EXIT_SECONDS = 60
MAX_RESULTS = 20

XML = '''<node><interface name="org.gnome.Shell.SearchProvider2">
<method name="GetInitialResultSet"><arg type="as" name="terms" direction="in"/><arg type="as" name="results" direction="out"/></method>
<method name="GetSubsearchResultSet"><arg type="as" name="previous_results" direction="in"/><arg type="as" name="terms" direction="in"/><arg type="as" name="results" direction="out"/></method>
<method name="GetResultMetas"><arg type="as" name="identifiers" direction="in"/><arg type="aa{sv}" name="metas" direction="out"/></method>
<method name="ActivateResult"><arg type="s" name="identifier" direction="in"/><arg type="as" name="terms" direction="in"/><arg type="u" name="timestamp" direction="in"/></method>
<method name="LaunchSearch"><arg type="as" name="terms" direction="in"/><arg type="u" name="timestamp" direction="in"/></method>
</interface></node>'''


def load_servers():
    try:
        with open(SERVERS_FILE, encoding='utf-8') as f:
            doc = json.load(f)
    except Exception:
        return []
    folders = {f.get('id'): f for f in doc.get('folders', [])}

    def folder_path(fid):
        parts, seen = [], set()
        while fid and fid in folders and fid not in seen:
            seen.add(fid)
            parts.insert(0, folders[fid].get('name', ''))
            fid = folders[fid].get('parentId')
        return ' / '.join(parts)

    out = []
    for s in doc.get('servers', []):
        if s.get('type') == 'local':
            if s.get('hidden'):
                continue
            desc, hay = 'Local shell', [s.get('name', '')]
        else:
            port = s.get('port', 22)
            desc = '%s@%s%s' % (s.get('username', ''), s.get('host', ''), '' if port == 22 else ':%s' % port)
            hay = [s.get('name', ''), s.get('host', ''), s.get('username', '')]
        path = folder_path(s.get('folderId'))
        if path:
            desc = '%s  ·  %s' % (path, desc)
            hay.append(path)
        out.append({'id': s.get('id'), 'name': s.get('name', ''), 'desc': desc, 'hay': ' '.join(hay).lower()})
    return out


def search(terms):
    terms = [t.lower() for t in terms if t.strip()]
    if not terms:
        return []
    hits = [s for s in load_servers() if all(t in s['hay'] for t in terms)]
    hits.sort(key=lambda s: (not s['name'].lower().startswith(terms[0]), s['name'].lower()))
    return [s['id'] for s in hits[:MAX_RESULTS]]


def launch(args):
    subprocess.Popen(COMMAND + args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


class Provider:
    def __init__(self, loop):
        self.loop = loop
        self.timer = None
        self.touch()

    def touch(self):
        if self.timer:
            GLib.source_remove(self.timer)
        self.timer = GLib.timeout_add_seconds(IDLE_EXIT_SECONDS, self.quit)

    def quit(self):
        self.loop.quit()
        return False

    def call(self, conn, sender, path, iface, method, params, invocation):
        self.touch()
        args = params.unpack()
        try:
            if method == 'GetInitialResultSet':
                invocation.return_value(GLib.Variant('(as)', (search(args[0]),)))
            elif method == 'GetSubsearchResultSet':
                invocation.return_value(GLib.Variant('(as)', (search(args[1]),)))
            elif method == 'GetResultMetas':
                by_id = {s['id']: s for s in load_servers()}
                metas = []
                for i in args[0]:
                    s = by_id.get(i)
                    if s:
                        metas.append({'id': GLib.Variant('s', i), 'name': GLib.Variant('s', s['name']),
                                      'description': GLib.Variant('s', s['desc']), 'gicon': GLib.Variant('s', ICON)})
                invocation.return_value(GLib.Variant('(aa{sv})', (metas,)))
            elif method == 'ActivateResult':
                launch(['--id=' + args[0]])
                invocation.return_value(None)
            elif method == 'LaunchSearch':
                launch([' '.join(args[0])])
                invocation.return_value(None)
            else:
                invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', method)
        except Exception as e:  # never crash the provider
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', str(e))


def main():
    loop = GLib.MainLoop()
    provider = Provider(loop)
    info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]

    def on_bus(conn, name):
        conn.register_object(OBJECT_PATH, info, provider.call, None, None)

    Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, on_bus, None, lambda *a: loop.quit())
    loop.run()


if __name__ == '__main__':
    main()
`
}
