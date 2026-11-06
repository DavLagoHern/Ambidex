import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { outDir: '../../out/renderer', emptyOutDir: true, target: 'safari15', sourcemap: false }
})
