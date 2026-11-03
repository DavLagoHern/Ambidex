import { execFileSync } from 'child_process'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared') }

// de qué clon y commit sale esta compilación: la app instalada se actualiza desde ahí (git pull + compilar)
function commit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define: { __AMBIDEX_SOURCE__: JSON.stringify(resolve('.')), __AMBIDEX_COMMIT__: JSON.stringify(commit()) },
    build: { target: 'node24', rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()]
  }
})
