import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isPortableMode,
  portableBaseDir,
  runtimeStorageRoot,
} from '../../packages/desktop/src/main/paths'
import { dataRootForPortableConfig } from '../../packages/desktop/src/main/desktop-identity'

// A path that is absolute on every platform but never inside the portable base.
// On Windows this is a drive letter the folder no longer sits on.
const PREVIOUS_LOCATION = '/mnt/old-drive/EkkoStudio/data/web-ui/desktop-runtime'

describe('portable runtime paths', () => {
  const savedEnv = { ...process.env }
  let base = ''
  let webUiHome = ''

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ekko-portable-'))
    webUiHome = join(base, 'data', 'web-ui')
    process.env.HERMES_DESKTOP_PORTABLE = '1'
    process.env.HERMES_DESKTOP_PORTABLE_DIR = base
    process.env.HERMES_WEB_UI_HOME = webUiHome
  })

  afterEach(() => {
    process.env = { ...savedEnv }
    ;(app as { isPackaged: boolean }).isPackaged = false
    rmSync(base, { recursive: true, force: true })
  })

  function writeActiveVersion(active: Record<string, unknown>) {
    const dir = join(webUiHome, 'desktop-runtime')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'active-version.json'), JSON.stringify({ schema: 1, ...active }))
  }

  it('anchors the portable base on the executable directory, not the cwd', () => {
    expect(portableBaseDir()).toBe(base)
    expect(isPortableMode()).toBe(true)
  })

  it('turns on by itself when the program folder ships a data directory', () => {
    delete process.env.HERMES_DESKTOP_PORTABLE
    ;(app as { isPackaged: boolean }).isPackaged = true
    mkdirSync(join(base, 'data'), { recursive: true })

    expect(isPortableMode()).toBe(true)
    expect(dataRootForPortableConfig(portableBaseDir(), {})).toBe(join(base, 'data'))
  })

  it('stays off when an installed copy has no data directory next to it', () => {
    delete process.env.HERMES_DESKTOP_PORTABLE
    ;(app as { isPackaged: boolean }).isPackaged = true

    expect(isPortableMode()).toBe(false)
  })

  it('stays off in an unpackaged checkout that happens to contain data/', () => {
    delete process.env.HERMES_DESKTOP_PORTABLE
    mkdirSync(join(base, 'data'), { recursive: true })

    expect(isPortableMode()).toBe(false)
  })

  it('drops a runtime root recorded at the previous drive letter', () => {
    writeActiveVersion({ platform: 'win32', runtimeRootDirectory: PREVIOUS_LOCATION })

    expect(runtimeStorageRoot()).toBe(join(webUiHome, 'desktop-runtime'))
  })

  it('keeps a runtime root that is still inside the portable directory', () => {
    const inside = join(base, 'relocated-runtime')
    writeActiveVersion({ platform: 'win32', runtimeRootDirectory: inside })

    expect(runtimeStorageRoot()).toBe(inside)
  })

  it('leaves the recorded root alone outside portable mode', () => {
    delete process.env.HERMES_DESKTOP_PORTABLE
    delete process.env.HERMES_DESKTOP_PORTABLE_DIR
    writeActiveVersion({ platform: 'win32', runtimeRootDirectory: PREVIOUS_LOCATION })

    expect(runtimeStorageRoot()).toBe(PREVIOUS_LOCATION)
  })
})

describe('portable data root', () => {
  it('defaults to data/ inside the program folder', () => {
    expect(dataRootForPortableConfig('/media/usb/EkkoStudio', {})).toBe('/media/usb/EkkoStudio/data')
  })

  it('honours a configured data directory', () => {
    expect(dataRootForPortableConfig('/media/usb/EkkoStudio', { dataDir: '/var/ekko' })).toBe('/var/ekko')
  })

  it('ignores a blank or non-string data directory', () => {
    expect(dataRootForPortableConfig('/media/usb/EkkoStudio', { dataDir: '  ' })).toBe('/media/usb/EkkoStudio/data')
    expect(dataRootForPortableConfig('/media/usb/EkkoStudio', { dataDir: 7 })).toBe('/media/usb/EkkoStudio/data')
  })
})
