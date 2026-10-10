import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureDesktopIdentity } from '../../packages/desktop/src/main/desktop-identity'
import { restoreEnv } from '../mocks/env'

describe('desktop identity across the Ekko Studio rename', () => {
  it.each([
    { platform: 'macOS', paths: posix, appData: '/Users/test/Library/Application Support' },
    { platform: 'Windows', paths: win32, appData: 'C:\\Users\\test\\AppData\\Roaming' },
    { platform: 'Linux', paths: posix, appData: '/home/test/.config' },
  ])('keeps the existing $platform Chromium profile after changing the display name', ({ paths, appData }) => {
    let name = 'hermes-studio'
    let pinnedUserData: string | undefined
    const app = {
      getPath: (key: string) => {
        if (key !== 'userData') throw new Error(`Unexpected path: ${key}`)
        return pinnedUserData ?? paths.join(appData, name)
      },
      setPath: (key: string, value: string) => {
        if (key !== 'userData') throw new Error(`Unexpected path: ${key}`)
        pinnedUserData = value
      },
      setName: (value: string) => { name = value },
      commandLine: { appendSwitch: () => {} },
    }
    const oldProfile = paths.join(appData, 'hermes-studio')

    configureDesktopIdentity(app)

    expect(name).toBe('Ekko Studio')
    expect(app.getPath('userData')).toBe(oldProfile)
    configureDesktopIdentity(app)
    expect(app.getPath('userData')).toBe(oldProfile)
  })

  it('preserves an explicitly configured profile path', () => {
    let userData = '/custom/studio-profile'
    const app = {
      getPath: () => userData,
      setPath: (_key: string, value: string) => { userData = value },
      setName: () => {},
      commandLine: { appendSwitch: () => {} },
    }

    configureDesktopIdentity(app)

    expect(userData).toBe('/custom/studio-profile')
  })
})

describe('portable desktop identity', () => {
  const savedEnv = { ...process.env }
  let base = ''
  let name = ''
  let setPaths: Record<string, string> = {}
  const switches: Array<[string, string]> = []

  const app = {
    getPath: (key: string) => setPaths[key] ?? '',
    setPath: (key: string, value: string) => { setPaths[key] = value },
    setName: (value: string) => { name = value },
    commandLine: {
      appendSwitch: (key: string, value: string) => { switches.push([key, value]) },
    },
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ekko-identity-'))
    process.env.HERMES_DESKTOP_PORTABLE = '1'
    process.env.HERMES_DESKTOP_PORTABLE_DIR = base
    name = ''
    setPaths = {}
    switches.length = 0
  })

  afterEach(() => {
    restoreEnv(savedEnv)
    rmSync(base, { recursive: true, force: true })
  })

  it('redirects every Chromium path into the program folder and exports the data homes', () => {
    configureDesktopIdentity(app)

    expect(name).toBe('Ekko Studio')
    expect(setPaths.userData).toBe(join(base, 'data', 'electron'))
    expect(setPaths.logs).toBe(join(base, 'data', 'logs'))
    expect(setPaths.temp).toBe(join(base, 'data', 'tmp'))
    expect(switches).toContainEqual(['disk-cache-dir', join(base, 'data', 'cache', 'chromium')])
    expect(process.env.HERMES_WEB_UI_HOME).toBe(join(base, 'data', 'web-ui'))
    expect(process.env.HERMES_WEBUI_STATE_DIR).toBe(join(base, 'data', 'web-ui'))
    expect(process.env.HERMES_HOME).toBe(join(base, 'data', 'hermes'))
    expect(process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE).toBe('false')
  })

  it('stores everything under a configured data directory instead', () => {
    const local = join(base, 'local-disk')
    mkdirSync(local, { recursive: true })
    writeFileSync(join(base, 'config.json'), JSON.stringify({ dataDir: local, port: 9001 }))

    configureDesktopIdentity(app)

    expect(setPaths.userData).toBe(join(local, 'electron'))
    expect(process.env.HERMES_HOME).toBe(join(local, 'hermes'))
    expect(process.env.HERMES_DESKTOP_PORT).toBe('9001')
  })

  it('never overrides an explicitly configured port', () => {
    process.env.HERMES_DESKTOP_PORT = '7777'
    writeFileSync(join(base, 'config.json'), JSON.stringify({ port: 9001 }))

    configureDesktopIdentity(app)

    expect(process.env.HERMES_DESKTOP_PORT).toBe('7777')
  })
})
