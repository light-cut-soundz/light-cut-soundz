import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // jsdom, so `main.js` (which wires the real markup on import) can be driven.
    environment: 'jsdom',
    include: ['src/**/*.test.js'],
    coverage: {
      // Only the app's own sources count. `docs/` is the GitHub Pages landing page.
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js'],
    },
  },
})
