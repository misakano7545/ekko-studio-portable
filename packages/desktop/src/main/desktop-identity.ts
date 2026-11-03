import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from 'electron'
import { dataRootForPortableConfig, isPortableMode, portableBaseDir, readPortableConfig } from './paths'

// Callers and tests already import it from this module.
export { dataRootForPortableConfig }

// `commandLine` is only read in portable mode, so a minimal install-mode stub
// still satisfies this type.
type DesktopIdentityApp = Pick<App, 'getPath' | 'setPath' | 'setName' | 'commandLine'>

function applyPortablePaths(app: DesktopIdentityApp): void {
  const base = portableBaseDir()
  const config = readPortableConfig(base)
  const configured = dataRootForPortableConfig(base, config)

  // An unusable dataDir must not kill the process before the window exists —
  // there would be no UI to correct it from and nothing on screen explaining
  // why. Fall back to the program folder; if even that fails the portable
  // premise is broken (read-only media) and failing loudly is the honest answer.
  let dataRoot = configured
  try {
    mkdirSync(dataRoot, { recursive: true })
  } catch (err) {
    console.error(
      `[desktop] unusable data directory ${dataRoot}: ${err instanceof Error ? err.message : String(err)}`,
    )
    dataRoot = join(base, 'data')
    mkdirSync(dataRoot, { recursive: true })
  }

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

  // os.tmpdir() reads these, and Electron's setPath('temp') does not set them on
  // Windows. The runtime download uses mkdtempSync(join(tmpdir(), ...)), so
  // without this a ~1.5 GB download lands in the system profile's temp folder.
  const temp = join(dataRoot, 'tmp')
  process.env.TMPDIR = temp
  process.env.TEMP = temp
  process.env.TMP = temp

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
    if (Number.isInteger(port) && port > 0 && port <= 65535) process.env.HERMES_DESKTOP_PORT = String(port)
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
