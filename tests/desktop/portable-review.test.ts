import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordRuntimeActivationError, runtimeStorageRoot } from '../../packages/desktop/src/main/paths'
import { configureDesktopIdentity, dataRootForPortableConfig } from '../../packages/desktop/src/main/desktop-identity'
import { restoreEnv } from '../mocks/env'

// Review findings for the portable build. Each case names the invariant the
// portable contract implies; a failure here is the bug, not a flaky test.

type FakeApp = {
  isPackaged: boolean
  getPath: (name: string) => string
  setPath: (name: string, value: string) => void
  setName: (name: string) => void
  commandLine: { appendSwitch: (key: string, value: string) => void }
}

function fakeApp(): FakeApp {
  const paths: Record<string, string> = { userData: '/tmp/unset' }
  return {
    isPackaged: false,
    getPath: name => paths[name] || '/tmp/unset',
    setPath: (name, value) => { paths[name] = value },
    setName: () => {},
    commandLine: { appendSwitch: () => {} },
  }
}

describe('portable review findings', () => {
  const savedEnv = { ...process.env }
  let program: string
  let externalData: string

  beforeEach(() => {
    program = mkdtempSync(join(tmpdir(), 'ekko-program-'))
    externalData = mkdtempSync(join(tmpdir(), 'ekko-external-data-'))
    process.env.HERMES_DESKTOP_PORTABLE = '1'
    process.env.HERMES_DESKTOP_PORTABLE_DIR = program
  })

  afterEach(() => {
    restoreEnv(savedEnv)
    rmSync(program, { recursive: true, force: true })
    rmSync(externalData, { recursive: true, force: true })
  })

  it('resolves a relative dataDir under the program folder, not the process cwd', () => {
    // cwd is whatever the shortcut/USB launcher happened to pass, so resolving
    // against it writes state to an arbitrary directory.
    expect(dataRootForPortableConfig(program, { dataDir: 'EkkoData' }))
      .toBe(join(program, 'EkkoData'))
  })

  it('keeps a scheduled runtime migration that lives under a configured data root', () => {
    // config.json moves the data root to a local disk (the USB calibration knob),
    // so the guard has to treat that root as inside the portable boundary too.
    const dataRoot = externalData
    writeFileSync(join(program, 'config.json'), JSON.stringify({ dataDir: dataRoot }))
    process.env.HERMES_WEB_UI_HOME = join(dataRoot, 'web-ui')
    const target = join(dataRoot, 'ekko-runtime')
    const file = join(dataRoot, 'web-ui', 'desktop-runtime', 'active-version.json')
    mkdirSync(join(dataRoot, 'web-ui', 'desktop-runtime'), { recursive: true })
    writeFileSync(file, JSON.stringify({ schema: 1, runtimeRootDirectory: target, pendingRuntimeRootDirectory: target }))

    // Any read-modify-write cycle (recording an activation error is one) must not
    // erase the scheduled migration: nothing re-derives it afterwards.
    recordRuntimeActivationError('runtime failed')

    const active = JSON.parse(readFileSync(file, 'utf-8'))
    expect(active.pendingRuntimeRootDirectory).toBe(target)
    expect(active.runtimeRootDirectory).toBe(target)
  })

  it('survives a dataDir that cannot be created instead of dying before the window opens', () => {
    const blocker = join(program, 'blocker')
    writeFileSync(blocker, 'not a directory')
    writeFileSync(join(program, 'config.json'), JSON.stringify({ dataDir: join(blocker, 'data') }))

    expect(() => configureDesktopIdentity(fakeApp() as never)).not.toThrow()
  })

  it('redirects the process temp directory, which os.tmpdir() actually reads', () => {
    writeFileSync(join(program, 'config.json'), JSON.stringify({}))
    configureDesktopIdentity(fakeApp() as never)

    // app.setPath('temp') does not touch these; the runtime download uses
    // mkdtempSync(join(tmpdir(), ...)), so the env var is what matters.
    expect(process.env.TEMP || process.env.TMPDIR).toBe(join(program, 'data', 'tmp'))
  })

  it('ignores a port outside the usable range instead of breaking the listener', () => {
    writeFileSync(join(program, 'config.json'), JSON.stringify({ port: 99999 }))

    configureDesktopIdentity(fakeApp() as never)

    expect(process.env.HERMES_DESKTOP_PORT).toBeUndefined()
  })

  it('reports the storage root derived from the current location', () => {
    process.env.HERMES_WEB_UI_HOME = join(externalData, 'web-ui')
    const file = join(externalData, 'web-ui', 'desktop-runtime', 'active-version.json')
    mkdirSync(join(externalData, 'web-ui', 'desktop-runtime'), { recursive: true })
    writeFileSync(file, JSON.stringify({ schema: 1, runtimeRootDirectory: join(externalData, 'web-ui', 'desktop-runtime') }))

    expect(runtimeStorageRoot()).toBe(join(externalData, 'web-ui', 'desktop-runtime'))
  })

  it('greys out the tray login-item toggle and reports it off, instead of no-opping a click', () => {
    // Normalize line endings: a Windows checkout hands us CRLF, and the second
    // pattern spans a line break.
    const main = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')

    // Source-level because the tray template is built inside the Electron entry,
    // which cannot be imported here. Matches how tray-icon.test.ts checks it.
    expect(main).toMatch(/enabled: \(process\.platform !== 'linux' \|\| app\.isPackaged\) && !isPortableMode\(\),/)
    expect(main).toMatch(/function getOpenAtLogin\(\): boolean \{\n(?:.*\n)*?\s*if \(isPortableMode\(\)\) return false/)
  })
})
