type SavedEnv = Record<string, string | undefined>

/**
 * Restore the environment key by key.
 *
 * `process.env = { ...saved }` looks equivalent but is not: after that whole-object
 * assignment, later per-key writes stop reaching the OS, so `os.tmpdir()` keeps
 * returning the value from before the assignment. A test that redirects TMPDIR and
 * then assigns the saved copy back leaves the next test's `mkdtempSync(join(tmpdir(),
 * ...))` pointing at this test's deleted folder.
 */
export function restoreEnv(saved: SavedEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value
  }
}
