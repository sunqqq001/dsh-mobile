import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The question-fixes component is its own package, so its tests live beside it.
    include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
})
