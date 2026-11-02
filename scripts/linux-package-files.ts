// Generates the system-wide files the .deb package installs (search provider, CLI wrapper).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SEARCH_BUS_NAME,
  SEARCH_INI_NAME,
  searchProviderIni,
  searchProviderScript,
  searchProviderService
} from '../src/main/desktop/searchProvider'

const out = join(process.cwd(), 'build/linux')
const script = '/usr/lib/prime-terminal/search-provider.py'
mkdirSync(out, { recursive: true })

const write = (name: string, content: string, mode = 0o644) => {
  const p = join(out, name)
  writeFileSync(p, content)
  chmodSync(p, mode)
}

write('search-provider.py', searchProviderScript({ serversFile: null, command: ['/usr/bin/prime-terminal'] }), 0o755)
write(`${SEARCH_BUS_NAME}.service`, searchProviderService('/usr/bin/env python3', script))
write(SEARCH_INI_NAME, searchProviderIni())
write('primeterminal', '#!/bin/sh\nexec /usr/bin/prime-terminal "$@"\n', 0o755)
console.log('linux package files written to build/linux')
