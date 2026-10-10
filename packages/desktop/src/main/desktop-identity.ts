import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { App } from 'electron'
import { isPortableMode, portableBaseDir } from './paths'

// `commandLine` is only read in portable mode, so a minimal install-mode stub
// still satisfies this type.
type DesktopIdentityApp = Pick<App, 'getPath' | 'setPath' | 'setName' | 'commandLine'>

export type PortableConfig = {
  dataDir?: unknown
  port?: unknown
}

function readPortableConfig(base: string): PortableConfig {
  try {
    return JSON.parse(readFileSync(join(base, 'config.json'), 'utf-8')) as PortableConfig
  } catch {
    return {}
  }
}

export function dataRootForPortableConfig(base: string, config: PortableConfig): string {
  const dataDir = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  // Calibration knob, not a feature: USB sticks have terrible random-write
  // throughput (SQLite plus logs stall on USB 2.0), so an operator can point the
  // data root at a local disk. The default stays inside the program folder.
  return dataDir ? resolve(dataDir) : join(base, 'data')
}

function applyPortablePaths(app: DesktopIdentityApp): void {
  const base = portableBaseDir()
  const config = readPortableConfig(base)
  const dataRoot = dataRootForPortableConfig(base, config)

  // Chromium writes all of these to the system profile unless redirected, which
  // is what makes an otherwise green install leave AppData behind.
  const redirects: Array<[string, string]> = [
    ['userData', join(dataRoot, 'electron')],
    ['sessionData', join(dataRoot, 'electron')],
    ['cache', join(dataRoot, 'cache')],
    ['logs', join(dataRoot, 'logs')],
    ['temp', join(dataRoot, 'tmp')],
    ['crashDumps', join(dataRoot, 'crash')],
  ]
  for (const [key, value] of redirects) {
    mkdirSync(value, { recursive: true })
    app.setPath(key, value)
  }
  // Chromium keeps its own cache directory and ignores setPath('cache').
  app.commandLine.appendSwitch('disk-cache-dir', join(dataRoot, 'cache', 'chromium'))

  // These are the only switches the rest of the process needs. Every consumer
  // reads them: paths.ts here, and the Web UI child process spawned by
  // webui-server.ts, which forwards them through as HERMES_HOME,
  // HERMES_WEB_UI_HOME and HERMES_WEBUI_STATE_DIR.
  const home = join(dataRoot, 'web-ui')
  process.env.HERMES_WEB_UI_HOME = home
  process.env.HERMES_WEBUI_STATE_DIR = home
  process.env.HERMES_HOME = join(dataRoot, 'hermes')
  // Desktop main reads this before it reads anything else; an explicit value wins.
  if (!process.env.HERMES_DESKTOP_PORT?.trim()) {
    const port = Number(config.port)
    if (Number.isInteger(port) && port > 0) process.env.HERMES_DESKTOP_PORT = String(port)
  }
  // A portable folder is updated by replacing the folder, so the in-app updater
  // has nothing to install into.
  process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE = 'false'
}

export function configureDesktopIdentity(app: DesktopIdentityApp) {
  if (isPortableMode()) {
    applyPortablePaths(app)
    app.setName('Ekko Studio')
    return
  }

  // Electron derives this path from package.json's name, not the installer display
  // name. Pin the existing profile before changing the name used by the UI.
  const existingUserData = app.getPath('userData')
  app.setPath('userData', existingUserData)
  app.setName('Ekko Studio')
}
