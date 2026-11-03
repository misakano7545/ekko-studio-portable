import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

// The portable build's own logic lives here, not inside paths.ts: this repo runs on
// top of a fast-moving upstream, and every line we add to an upstream file is a line
// the daily rebase has to merge. Upstream has no version of this file, so it never
// conflicts.

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
  // paths.ts's isPackaged() reads the same field; inlined so this module does not
  // import paths.ts at runtime (paths.ts imports this one).
  return !!app?.isPackaged && existsSync(join(portableBaseDir(), 'data'))
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

const PORTABLE_PATH_KEYS = [
  'runtimeDirectory',
  'runtimeRootDirectory',
  'pendingRuntimeRootDirectory',
  'webUiDirectory',
] as const

/**
 * A no-op unless the app is running from a portable folder.
 *
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
 * file is read. Generic so this module needs no type from paths.ts: paths.ts
 * imports it, and that import direction has to stay one-way.
 */
export function sanitizeActiveRuntime<T extends object>(active: T): T {
  if (!isPortableMode()) return active

  const base = resolve(portableBaseDir())
  const dataRoot = resolve(dataRootForPortableConfig(base, readPortableConfig(base)))
  const boundaries = dataRoot === base ? [base] : [base, dataRoot]
  const isInside = (value: unknown): boolean => {
    if (typeof value !== 'string' || !value.trim()) return false
    const resolved = resolve(value.trim())
    return boundaries.some(boundary => resolved === boundary || resolved.startsWith(boundary + sep))
  }

  const portable = { ...active } as Record<string, unknown>
  for (const key of PORTABLE_PATH_KEYS) {
    const value = portable[key]
    if (typeof value === 'string' && !isInside(value)) {
      delete portable[key]
      console.warn(`[desktop] dropped recorded ${key} outside the portable folder: ${value}`)
    }
  }
  return portable as unknown as T
}
