import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
let commit = ''
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
await build({
  entryPoints: ['src/engine/index.ts'], outfile: 'out/engine/index.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', packages: 'external',
  alias: { '@shared': resolve('src/shared') },
  define: { __AMBIDEX_SOURCE__: JSON.stringify(resolve('.')), __AMBIDEX_COMMIT__: JSON.stringify(commit) }
})
