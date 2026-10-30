import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST
// Set by the Tauri CLI (v2): `TAURI_ENV_DEBUG` is "true" for debug builds, and
// the platform picks the WebView the code has to run on.
const debug = process.env.TAURI_ENV_DEBUG === 'true'

export default defineConfig({
  clearScreen: false,
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5183 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/target/**', '**/dist/**', '**/coverage/**'] },
  },
  // Only `VITE_*` and the non-secret `TAURI_ENV_*` reach the bundle. A bare
  // `TAURI_` prefix would also expose `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`,
  // which the release build has in its environment, to `import.meta.env`.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: debug ? false : 'esbuild',
    sourcemap: debug,
  },
})
