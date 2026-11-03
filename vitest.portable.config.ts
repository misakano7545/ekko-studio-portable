import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The portable gate gets its own config, and its tests get their own directory
// (tests-portable/), for one reason: they import packages/desktop/src/main, which
// reads `electron` at import time. Upstream rewrites its test setup wholesale —
// 081b9393 deleted the legacy suite and with it the `electron` alias these tests
// resolved through — so the gate must not live inside the repo's test config.
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests-portable/mocks/electron.ts'),
    },
  },
  test: {
    include: ['tests-portable/**/*.test.ts'],
  },
})
