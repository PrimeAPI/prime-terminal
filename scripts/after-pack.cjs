// electron-builder afterPack hook (Linux): put a small launcher in front of the Electron binary.
// On distributions that restrict unprivileged user namespaces (Ubuntu 24.04+), Chromium's sandbox
// cannot start inside an AppImage (no SUID helper possible), so the launcher adds --no-sandbox there.
// The .deb is not affected: its post-install script sets up the SUID sandbox helper.
const { chmodSync, renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return
  const name = context.packager.executableName
  const dir = context.appOutDir
  renameSync(join(dir, name), join(dir, `${name}-bin`))
  const launcher = `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
if [ -n "$APPIMAGE" ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ]; then
  exec "$HERE/${name}-bin" --no-sandbox "$@"
fi
exec "$HERE/${name}-bin" "$@"
`
  writeFileSync(join(dir, name), launcher)
  chmodSync(join(dir, name), 0o755)
}
