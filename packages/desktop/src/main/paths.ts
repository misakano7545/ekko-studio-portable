import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { homedir, platform } from 'node:os'
import {
  resolveRuntimeResourceDir,
  runtimePlatformKey,
  type DesktopRuntimeResource,
} from './runtime-paths'
import { hermesAgentVersionFromRuntimeTag } from './runtime-version'

const isWin = platform() === 'win32'
const DEFAULT_HERMES_AGENT_VERSION = '0.21.5'
const PACKAGED_RUNTIME_RELEASE_NAME = 'runtime-release.json'
const ACTIVE_RUNTIME_VERSION_NAME = 'active-version.json'
let incompleteActiveWebUiWarningPath = ''

export function isPackaged() {
  return !!app?.isPackaged
}

/**
 * Root of a green install: the directory that holds the executable. Everything
 * a portable install writes lives underneath it.
 *
 * `process.cwd()` is deliberately not used — a shortcut, a USB drive and an
 * AppImage all launch the app with an arbitrary working directory, so the
 * program folder would be misidentified and state written to the wrong place.
 */
export function portableBaseDir(): string {
  const override = process.env.HERMES_DESKTOP_PORTABLE_DIR?.trim()
  if (override) return resolve(override)
  if (process.env.APPIMAGE) return dirname(resolve(process.env.APPIMAGE))
  return dirname(process.execPath)
}

/**
 * Portable mode is opt-in: the folder ships with a `data/` directory next to the
 * executable, and the presence of that directory *is* the marker — no separate
 * flag file. A copy of the app that is missing `data/` (an installed build in
 * Program Files, a dev checkout) is not portable and behaves as before.
 *
 * The environment variable wins so development builds and tests can exercise the
 * portable paths without a packaged application.
 */
export function isPortableMode(): boolean {
  const flag = process.env.HERMES_DESKTOP_PORTABLE?.trim().toLowerCase()
  if (flag) return !['0', 'false', 'no', 'off'].includes(flag)
  return isPackaged() && existsSync(join(portableBaseDir(), 'data'))
}

export type PortableConfig = {
  dataDir?: unknown
  port?: unknown
}

export function readPortableConfig(base: string): PortableConfig {
  const file = join(base, 'config.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as PortableConfig
  } catch (err) {
    // Swallowing this silently means a typo in config.json looks like the
    // setting simply has no effect, and the data lands in the default folder.
    console.warn(`[desktop] ignoring unreadable ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

export function dataRootForPortableConfig(base: string, config: PortableConfig): string {
  const dataDir = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  // Calibration knob, not a feature: USB sticks have terrible random-write
  // throughput (SQLite plus logs stall on USB 2.0), so an operator can point the
  // data root at a local disk. The default stays inside the program folder.
  //
  // Resolved against the program folder, never the cwd: a shortcut, a USB drive
  // and an AppImage all launch with an arbitrary working directory.
  return dataDir ? resolve(base, dataDir) : join(base, 'data')
}

export function defaultWebuiDir(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'webui')
  return process.env.HERMES_WEB_UI_DIR?.trim() || resolve(app?.getAppPath?.() || resolve(process.cwd(), 'packages', 'desktop'), '..', '..')
}

export { runtimePlatformKey }

type RuntimeReleaseMetadata = {
  tag?: string
  hermesAgentVersion?: string
}

type ActiveRuntimeVersion = {
  schema?: unknown
  desktopAppVersion?: unknown
  platform?: unknown
  webUiVersion?: unknown
  runtimeDirectory?: unknown
  runtimeRootDirectory?: unknown
  pendingRuntimeRootDirectory?: unknown
  runtimeMigrationError?: unknown
  runtimeActivationError?: unknown
  runtimeValidationFailures?: RuntimeValidationFailure[]
  webUiDirectory?: unknown
  updatedAt?: unknown
}

type RuntimeValidationFailure = {
  version: string
  platform: string
  directory: string
  reason: string
  failedAt: string
}

function runtimeRequiredFileGroups(root: string): string[][] {
  const sourceRoot = join(root, 'python')
  const environmentRoot = runtimePythonEnvironmentRoot(sourceRoot)
  const python = runtimePythonExecutable(environmentRoot)
  const hermes = isWin
    ? [
        join(environmentRoot, 'Scripts', 'hermes.cmd'),
        join(environmentRoot, 'Scripts', 'hermes.exe'),
      ]
    : [join(environmentRoot, 'bin', 'hermes')]
  const node = isWin ? join(root, 'node', 'node.exe') : join(root, 'node', 'bin', 'node')
  const groups = [
    [python],
    hermes,
    [node],
  ]
  if (isWin) groups.push([join(root, 'git', 'cmd', 'git.exe')])
  return groups
}

function missingRuntimeFiles(root: string): string[] {
  return runtimeRequiredFileGroups(root)
    .filter(files => !files.some(existsSync))
    .map(files => files.map(file => relative(root, file)).join(' or '))
}

function runtimeDirectoryReady(root: string): boolean {
  return missingRuntimeFiles(root).length === 0
}

function readRuntimeManifestVersion(runtimeDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(runtimeDir, 'runtime-manifest.json'), 'utf-8')) as {
      hermesAgentVersion?: unknown
      asset?: { name?: unknown }
    }
    if (typeof manifest.hermesAgentVersion === 'string' && manifest.hermesAgentVersion.trim()) {
      return manifest.hermesAgentVersion.trim()
    }
    const assetName = typeof manifest.asset?.name === 'string' ? manifest.asset.name : ''
    const match = assetName.match(/hermes-agent-([^-]+)-/)
    return match?.[1] || null
  } catch {
    return null
  }
}

function installedRuntimeDirectories(): Array<{ directory: string; version: string }> {
  const root = join(runtimeStorageRoot(), 'hermes')
  const currentPlatform = runtimePlatformKey()
  if (!existsSync(root)) return []
  const failedDirectories = new Set(
    (readActiveRuntimeVersion()?.runtimeValidationFailures || [])
      .map(failure => resolve(failure.directory)),
  )

  const runtimes: Array<{ directory: string; version: string }> = []
  try {
    for (const versionEntry of readdirSync(root, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) continue
      const platformDir = join(root, versionEntry.name, currentPlatform)
      if (failedDirectories.has(resolve(platformDir))) continue
      if (!runtimeDirectoryReady(platformDir)) continue
      runtimes.push({
        directory: platformDir,
        version: readRuntimeManifestVersion(platformDir) || versionEntry.name,
      })
    }
  } catch {
    return []
  }

  return runtimes.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
}

function activeRuntimeVersionFile(): string {
  return join(webUiHome(), 'desktop-runtime', ACTIVE_RUNTIME_VERSION_NAME)
}

function readActiveRuntimeVersion(): ActiveRuntimeVersion | null {
  const file = activeRuntimeVersionFile()
  if (!existsSync(file)) return null
  try {
    const active = JSON.parse(readFileSync(file, 'utf-8')) as ActiveRuntimeVersion
    return isPortableMode() ? dropPathsOutsidePortableBase(active) : active
  } catch {
    return null
  }
}

const PORTABLE_PATH_KEYS = [
  'runtimeDirectory',
  'runtimeRootDirectory',
  'pendingRuntimeRootDirectory',
  'webUiDirectory',
] as const

/**
 * A copy of the app only ever addresses files inside its own folder — the
 * program folder, plus the data root when config.json points it at a local disk
 * (the reason that knob exists). A recorded absolute path outside both is stale:
 * the drive letter or the folder moved.
 *
 * Dropping those keys makes the directory get re-derived from the current
 * location. Keeping a dead one strands a multi-gigabyte runtime: every lookup
 * points at the previous location and the relocation repair is handed the same
 * dead path.
 *
 * One guard here covers all four callers, because this is the single place the
 * file is read.
 */
function dropPathsOutsidePortableBase(active: ActiveRuntimeVersion): ActiveRuntimeVersion {
  const base = resolve(portableBaseDir())
  const dataRoot = resolve(dataRootForPortableConfig(base, readPortableConfig(base)))
  const boundaries = dataRoot === base ? [base] : [base, dataRoot]
  const isInside = (value: unknown): boolean => {
    if (typeof value !== 'string' || !value.trim()) return false
    const resolved = resolve(value.trim())
    return boundaries.some(boundary => resolved === boundary || resolved.startsWith(boundary + sep))
  }

  const portable: ActiveRuntimeVersion = { ...active }
  for (const key of PORTABLE_PATH_KEYS) {
    const value = portable[key]
    if (typeof value === 'string' && !isInside(value)) {
      delete portable[key]
      console.warn(`[desktop] dropped recorded ${key} outside the portable folder: ${value}`)
    }
  }
  return portable
}

export function recordRuntimeActivationError(error: string): void {
  const active = readActiveRuntimeVersion()
  if (!active) return
  const file = activeRuntimeVersionFile()
  if (active.runtimeActivationError === error) return
  try {
    writeFileSync(file, JSON.stringify({
      ...active,
      runtimeActivationError: error,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n')
  } catch (err) {
    console.warn(
      `[runtime] failed to persist Runtime activation error: `
      + `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function recordRuntimeSelectionResult(
  failures: Array<{ directory: string; reason: string; version?: string }>,
  selected?: { directory: string; version: string },
): void {
  if (failures.length === 0) return
  const active = readActiveRuntimeVersion() || { schema: 1 }
  const detail = failures
    .map(failure => `Runtime "${failure.directory}" failed: ${failure.reason}`)
    .join(' ')
  const failedAt = new Date().toISOString()
  const failedDirectories = new Set(failures.map(failure => resolve(failure.directory)))
  const selectedDirectory = selected ? resolve(selected.directory) : ''
  const runtimeValidationFailures: RuntimeValidationFailure[] = [
    ...(active.runtimeValidationFailures || []).filter(failure => {
      const directory = resolve(failure.directory)
      return directory !== selectedDirectory && !failedDirectories.has(directory)
    }),
    ...failures.map(failure => ({
      version: failure.version || basename(dirname(failure.directory)),
      platform: runtimePlatformKey(),
      directory: failure.directory,
      reason: failure.reason,
      failedAt,
    })),
  ]
  const next: Record<string, unknown> = {
    ...active,
    schema: 1,
    runtimeActivationError: selected
      ? `${detail} Using fallback Runtime "${selected.directory}".`
      : `${detail} No usable installed Runtime was found.`,
    runtimeValidationFailures,
    updatedAt: failedAt,
  }
  if (selected) {
    next.runtimeDirectory = selected.directory
    next.hermesRuntimeVersion = selected.version
    next.platform = runtimePlatformKey()
  } else {
    delete next.runtimeDirectory
    delete next.hermesRuntimeVersion
  }
  const file = activeRuntimeVersionFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  } catch (err) {
    console.warn(
      `[runtime] failed to persist Runtime selection result: `
      + `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function clearActiveWebUiDirectory(expectedDirectory?: string): void {
  const file = activeRuntimeVersionFile()
  const active = readActiveRuntimeVersion()
  if (!active || typeof active !== 'object') return
  const currentDirectory = typeof active.webUiDirectory === 'string' ? active.webUiDirectory.trim() : ''
  const currentVersion = typeof active.webUiVersion === 'string'
    ? active.webUiVersion.trim().replace(/^v/, '')
    : ''
  if (!currentDirectory && !currentVersion) return
  const derivedDirectory = currentVersion
    ? join(runtimeStorageRoot(), 'webui', currentVersion)
    : currentDirectory
  if (expectedDirectory && resolve(derivedDirectory) !== resolve(expectedDirectory)) return

  const next = { ...(active as Record<string, unknown>) }
  delete next.webUiDirectory
  delete next.webUiVersion
  try {
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  } catch (err) {
    console.warn('[desktop] failed to clear active Web UI directory:', err instanceof Error ? err.message : String(err))
  }
}

// Bundled web-ui directory.
// dev:  <repo root> (or HERMES_WEB_UI_DIR)
// prod: <resources>/webui
export function webuiServerEntryFor(root: string): string {
  return join(root, 'dist', 'server', 'index.js')
}

function webuiDirectoryReady(root: string): boolean {
  return existsSync(webuiServerEntryFor(root))
}

// active-version.json pins a Web UI version; its directory is derived from desktop runtime storage.
export function webuiDir(): string {
  const override = process.env.HERMES_WEB_UI_DIR?.trim()
  if (override) return resolve(override)

  const active = readActiveRuntimeVersion()
  const activeWebUiVersion = typeof active?.webUiVersion === 'string'
    ? active.webUiVersion.trim().replace(/^v/, '')
    : ''
  const activeWebUiDirectory = activeWebUiVersion
    ? join(runtimeStorageRoot(), 'webui', activeWebUiVersion)
    : ''
  if (active?.platform === runtimePlatformKey()
    && activeWebUiDirectory
    && webuiDirectoryReady(activeWebUiDirectory)) {
    return resolve(activeWebUiDirectory)
  }

  if (active?.platform === runtimePlatformKey()
    && activeWebUiDirectory
    && existsSync(activeWebUiDirectory)
    && incompleteActiveWebUiWarningPath !== activeWebUiDirectory) {
    incompleteActiveWebUiWarningPath = activeWebUiDirectory
    console.warn(`[desktop] ignored incomplete active Web UI directory ${activeWebUiDirectory}; missing ${webuiServerEntryFor(activeWebUiDirectory)}`)
    clearActiveWebUiDirectory()
  } else if (active?.platform === runtimePlatformKey() && activeWebUiVersion && !existsSync(activeWebUiDirectory)) {
    console.warn(`[desktop] active Web UI ${activeWebUiVersion} was not found in desktop runtime storage; using bundled Web UI`)
    clearActiveWebUiDirectory()
  }

  return defaultWebuiDir()
}

export function webuiServerEntry(): string {
  return webuiServerEntryFor(webuiDir())
}

function runtimeReleaseMetadata(): RuntimeReleaseMetadata | null {
  const candidates = isPackaged()
    ? [join(process.resourcesPath, 'build', PACKAGED_RUNTIME_RELEASE_NAME)]
    : [join(app?.getAppPath?.() || resolve(process.cwd(), 'packages', 'desktop'), 'build', PACKAGED_RUNTIME_RELEASE_NAME)]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const metadata = JSON.parse(readFileSync(candidate, 'utf-8')) as { tag?: unknown; hermesAgentVersion?: unknown }
      return {
        tag: typeof metadata.tag === 'string' && metadata.tag.trim() ? metadata.tag.trim() : undefined,
        hermesAgentVersion: typeof metadata.hermesAgentVersion === 'string' && metadata.hermesAgentVersion.trim()
          ? metadata.hermesAgentVersion.trim()
          : undefined,
      }
    } catch {}
  }

  return null
}

export function desktopRuntimeVersion(): string {
  const releaseTag = process.env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG?.trim()
  const versionFromTag = hermesAgentVersionFromRuntimeTag(releaseTag)
  if (versionFromTag) return versionFromTag

  const metadata = runtimeReleaseMetadata()
  if (metadata?.hermesAgentVersion) return metadata.hermesAgentVersion

  const versionFromMetadataTag = hermesAgentVersionFromRuntimeTag(metadata?.tag)
  if (versionFromMetadataTag) return versionFromMetadataTag

  const versionOverride = process.env.HERMES_VERSION?.trim()
  if (versionOverride) return versionOverride

  return DEFAULT_HERMES_AGENT_VERSION
}

export function targetDesktopRuntimeDir(): string {
  const override = process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()
  if (override) return resolve(override)
  return join(runtimeStorageRoot(), 'hermes', desktopRuntimeVersion(), runtimePlatformKey())
}

export function runtimeStorageRoot(): string {
  const active = readActiveRuntimeVersion()
  const configured = typeof active?.runtimeRootDirectory === 'string'
    ? active.runtimeRootDirectory.trim()
    : ''
  return configured ? resolve(configured) : join(webUiHome(), 'desktop-runtime')
}

export function desktopRuntimeDir(): string {
  const override = process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()
  if (override) return resolve(override)

  const active = readActiveRuntimeVersion()
  const currentPlatform = runtimePlatformKey()
  const activeDirectory = typeof active?.runtimeDirectory === 'string'
    ? active.runtimeDirectory.trim()
    : ''
  let activationError = ''
  if (activeDirectory) {
    if (active?.platform !== currentPlatform) {
      activationError = `Selected Runtime "${activeDirectory}" targets ${String(active?.platform || 'an unknown platform')}; expected ${currentPlatform}.`
    } else {
      const missing = missingRuntimeFiles(activeDirectory)
      if (missing.length === 0) return resolve(activeDirectory)
      activationError = `Selected Runtime "${activeDirectory}" is incomplete; missing: ${missing.join(', ')}.`
    }
  }

  const installed = installedRuntimeDirectories()
  const fallback = installed[0]?.directory
  if (active && activationError) {
    const detail = fallback
      ? `${activationError} Falling back to "${fallback}".`
      : `${activationError} No usable installed Runtime was found.`
    console.warn(`[runtime] ${detail}`)
    recordRuntimeActivationError(detail)
  }
  if (fallback) return resolve(fallback)

  return targetDesktopRuntimeDir()
}

function desktopAppPath(): string {
  return app?.getAppPath?.() || resolve(process.cwd(), 'packages', 'desktop')
}

export function runtimeResourceDir(name: DesktopRuntimeResource, packaged: boolean, appPath = desktopAppPath()): string {
  if (process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim()) {
    return join(desktopRuntimeDir(), name)
  }
  return resolveRuntimeResourceDir(name, packaged, appPath, desktopRuntimeDir(), runtimePlatformKey())
}

// dev:  packages/desktop/resources/python/<os>-<arch>
// prod: downloaded runtime cache under Web UI home.
export function pythonDir(): string {
  return runtimeResourceDir('python', isPackaged())
}

export function pythonEnvironmentDir(): string {
  return runtimePythonEnvironmentRoot(pythonDir())
}

function runtimePythonEnvironmentRoot(sourceRoot: string): string {
  const venvRoot = join(sourceRoot, 'venv')
  const venvPythons = isWin
    ? [join(venvRoot, 'Scripts', 'python.exe'), join(venvRoot, 'python.exe')]
    : [join(venvRoot, 'bin', 'python3')]
  return venvPythons.some(existsSync) ? venvRoot : sourceRoot
}

function runtimePythonExecutable(environmentRoot: string): string {
  if (!isWin) return join(environmentRoot, 'bin', 'python3')
  const standardVenvPython = join(environmentRoot, 'Scripts', 'python.exe')
  return existsSync(standardVenvPython)
    ? standardVenvPython
    : join(environmentRoot, 'python.exe')
}

function windowsHermesLauncher(environmentRoot: string): string {
  const scriptsRoot = join(environmentRoot, 'Scripts')
  const commandWrapper = join(scriptsRoot, 'hermes.cmd')
  const executable = join(scriptsRoot, 'hermes.exe')
  return existsSync(commandWrapper) || !existsSync(executable)
    ? commandWrapper
    : executable
}

export function nodeDir(): string {
  return runtimeResourceDir('node', isPackaged())
}

export function nodeBinDir(): string {
  const dir = nodeDir()
  return isWin ? dir : join(dir, 'bin')
}

export function bundledNode(): string {
  return isWin ? join(nodeDir(), 'node.exe') : join(nodeBinDir(), 'node')
}

export function gitDir(): string {
  return runtimeResourceDir('git', isPackaged())
}

export function gitPathDirs(): string[] {
  if (!isWin) return []
  const dir = gitDir()
  return [
    join(dir, 'cmd'),
    join(dir, 'mingw64', 'bin'),
    // Do not expose Git for Windows' Unix toolchain on PATH. Its usr/bin
    // includes GNU tools like du.exe/find.exe, which can be picked up by
    // Hermes or subprocesses and recursively scan Windows profile/AppData
    // trees. We pass git.exe explicitly via HERMES_AGENT_GIT instead.
  ].filter(existsSync)
}

export function bundledGit(): string | undefined {
  if (!isWin) return undefined
  const git = join(gitDir(), 'cmd', 'git.exe')
  return existsSync(git) ? git : undefined
}

export function bundledAgentBrowserHome(): string {
  return join(pythonDir(), 'agent-browser')
}

function browserExecutableNames(): Set<string> {
  if (isWin) return new Set(['chrome.exe'])
  if (platform() === 'darwin') return new Set(['Google Chrome for Testing', 'Google Chrome', 'Chromium', 'chrome'])
  return new Set(['chrome', 'chromium', 'chromium-browser'])
}

export function bundledBrowserExecutable(): string | undefined {
  const names = browserExecutableNames()
  const stack = [join(bundledAgentBrowserHome(), 'browsers'), bundledAgentBrowserHome()].filter(existsSync)
  const visited = new Set<string>()

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir || visited.has(dir)) continue
    visited.add(dir)

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && names.has(entry.name)) return path
      if (entry.isDirectory()) stack.push(path)
    }
  }

  return undefined
}

export function pythonBinDir(): string {
  const dir = pythonEnvironmentDir()
  return isWin ? join(dir, 'Scripts') : join(dir, 'bin')
}

export function bundledPython(): string {
  const dir = pythonEnvironmentDir()
  return runtimePythonExecutable(dir)
}

export function hermesBin(): string {
  return isWin ? windowsHermesLauncher(pythonEnvironmentDir()) : join(pythonBinDir(), 'hermes')
}

export function hermesBinExists(): boolean {
  return existsSync(hermesBin())
}

export function desktopIcon(): string {
  const filename = process.platform === 'linux' ? 'iconLinux.png' : 'icon.png'
  if (isPackaged()) return resolve(process.resourcesPath, 'build', filename)
  return resolve(desktopAppPath(), 'build', filename)
}

export function desktopWindowsTrayIcon(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'build', 'trayWindows.png')
  return resolve(desktopAppPath(), 'build', 'trayWindows.png')
}

export function desktopMacTrayIcon(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'build', 'trayMac.png')
  return resolve(desktopAppPath(), 'build', 'trayMac.png')
}

export function desktopLinuxTrayIcon(): string {
  if (isPackaged()) return resolve(process.resourcesPath, 'build', 'trayLinux.png')
  return resolve(desktopAppPath(), 'build', 'trayLinux.png')
}

export function webUiHome(): string {
  return process.env.HERMES_WEB_UI_HOME?.trim() || resolve(homedir(), '.hermes-web-ui')
}

export function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim()
  if (override) return resolve(override)

  const userHome = isWin ? process.env.USERPROFILE?.trim() || homedir() : homedir()
  return resolve(userHome, '.hermes')
}

export function tokenFile(): string {
  return join(webUiHome(), '.token')
}
