import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The bundled runtime is built upstream from MinGit, which ships usr/bin/sh.exe — bash under
// another name — but no bash.exe. Hermes' Windows shell discovery only accepts a file named
// bash.exe, so buildAgentBridgeProcessEnv materializes one and points HERMES_GIT_BASH_PATH at
// it; without that every shell-backed agent tool (terminal/read_file/search_files) fails.
describe('agent bridge env with a bundled runtime', () => {
  const originalPlatform = process.platform
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hermes-bundled-git-'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    rmSync(root, { recursive: true, force: true })
  })

  // Mirrors the shipped layout: <runtime>/python is the agent root, <runtime>/git its Git.
  function writeRuntime({ sh = true, bash = false } = {}) {
    const runtime = join(root, 'web-ui', 'desktop-runtime', 'hermes', '0.21.5', 'win-x64')
    const agentRoot = join(runtime, 'python')
    const bin = join(runtime, 'git', 'usr', 'bin')
    mkdirSync(agentRoot, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    if (sh) writeFileSync(join(bin, 'sh.exe'), 'sh-binary')
    if (bash) writeFileSync(join(bin, 'bash.exe'), 'existing-bash')
    return { agentRoot, bash: join(bin, 'bash.exe') }
  }

  it('materializes bash.exe beside sh.exe and tells Hermes where it is', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const { agentRoot, bash } = writeRuntime()
    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')

    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', agentRoot)

    expect(env.HERMES_GIT_BASH_PATH).toBe(bash)
    expect(existsSync(bash)).toBe(true)
  })

  it('leaves an existing bash.exe alone', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const { agentRoot, bash } = writeRuntime({ bash: true })
    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')

    buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', agentRoot)

    expect(readFileSync(bash, 'utf8')).toBe('existing-bash')
  })

  it('sets nothing when the runtime ships no shell at all', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const { agentRoot, bash } = writeRuntime({ sh: false })
    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')

    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', agentRoot)

    expect(env.HERMES_GIT_BASH_PATH).toBeUndefined()
    expect(existsSync(bash)).toBe(false)
  })

  it('hands Hermes no bash path off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const { agentRoot, bash } = writeRuntime()
    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')

    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', agentRoot)

    expect(env.HERMES_GIT_BASH_PATH).toBeUndefined()
    expect(existsSync(bash)).toBe(false)
  })
})
