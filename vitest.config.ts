import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,   // integration tests hit a real DB that may have 10k+ rows
    hookTimeout: 30_000,
  },
})
