import { spawn } from 'node:child_process'
import { context } from 'esbuild'
import { resolve } from 'node:path'
const engine = await context({
  entryPoints: ['src/engine/index.ts'], outfile: 'out/engine/index.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external',
  alias: { '@shared': resolve('src/shared') },
  define: { __AMBIDEX_SOURCE__: JSON.stringify(resolve('.')), __AMBIDEX_COMMIT__: '""' }
})
await engine.watch()
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })
const stop = async () => { vite.kill(); await engine.dispose(); process.exit() }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
vite.on('exit', stop)
