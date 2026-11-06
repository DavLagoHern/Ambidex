// macOS comparison using separate copies of the same test database.
// Launch Services gives the app its own responsible PID, used to attribute WebKit helpers.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') throw Error('This benchmark requires macOS footprint.')
const source = process.argv[2]
if (!source || !existsSync(source)) throw Error('Usage: node scripts/benchmark-native.mjs <isolated seeded test-data directory>')
const cwd = resolve(import.meta.dirname, '..')
const reportDir = mkdtempSync(join(tmpdir(), 'ambidex-benchmark-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const table = () => execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
  .trim().split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    return m ? [{ pid: +m[1], parent: +m[2], rssKiB: +m[3], command: m[4] }] : []
  })
const tree = (rows, pid) => {
  const ids = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const p of rows) if (ids.has(p.parent) && !ids.has(p.pid)) { ids.add(p.pid); changed = true }
  }
  return ids
}
const results = []
for (const [name, relative, executable] of [
  ['electron', 'dist/mac-arm64/Ambidex.app', 'Ambidex'],
  ['tauri', 'src-tauri/target/release/bundle/macos/Ambidex.app', 'ambidex']
]) {
  const bundle = join(cwd, relative)
  if (!existsSync(bundle)) continue
  const binary = join(bundle, 'Contents/MacOS', executable)
  const data = join(reportDir, name)
  mkdirSync(data); cpSync(source, data, { recursive: true })
  const before = new Set(table().map(p => p.pid))
  const opener = spawn('/usr/bin/open', [
    '-n', '-g', '-W', '--env', `AMBIDEX_USER_DATA=${data}`, '--env', 'AMBIDEX_TEST=1',
    '--env', `AMBIDEX_NODE_BIN=${process.execPath}`, bundle
  ], { stdio: 'ignore' })
  let pid
  try {
    for (let i = 0; i < 100 && !pid; i++) {
      pid = table().find(p => !before.has(p.pid) && (p.command === binary || p.command.startsWith(binary + ' ')))?.pid
      if (!pid) await sleep(100)
    }
    if (!pid) throw Error(name + ' did not launch')
    for (let i = 0; i < 66; i++) {
      await sleep(1000)
      if (!table().some(p => p.pid === pid)) throw Error(name + ' exited early')
    }
    const rows = table(), ids = tree(rows, pid)
    const webkit = rows.filter(p => !before.has(p.pid) && p.command.includes('/WebKit.framework/'))
    const ownership = JSON.parse(execFileSync('python3', ['-c',
      "import ctypes,json,sys;f=ctypes.CDLL('/usr/lib/libSystem.B.dylib').responsibility_get_pid_responsible_for_pid;f.argtypes=[ctypes.c_int];f.restype=ctypes.c_int;print(json.dumps({p:f(int(p)) for p in sys.argv[1:]}))",
      String(pid), ...webkit.map(p => String(p.pid))
    ], { encoding: 'utf8' }))
    for (const p of webkit) if (ownership[p.pid] === pid) ids.add(p.pid)
    if (name === 'tauri' && !webkit.some(p => ownership[p.pid] === pid)) {
      throw Error('Could not attribute WebKit helpers: ' + JSON.stringify({ pid, ownership }))
    }
    const processes = rows.filter(p => ids.has(p.pid))
    const output = join(reportDir, name + '-footprint.json')
    execFileSync('footprint', ['--noCategories', '-f', 'bytes', '-j', output, ...processes.map(p => String(p.pid))], { stdio: 'ignore' })
    const footprint = JSON.parse(readFileSync(output, 'utf8'))
    const physicalBytes = footprint.processes.reduce((n, p) => n + (p.footprint || 0), 0)
    const diskKiB = +execFileSync('du', ['-sk', bundle], { encoding: 'utf8' }).split(/\s/)[0]
    const result = { name, diskBytes: diskKiB * 1024, physicalBytes, processes: processes.map(p => ({ pid: p.pid, name: p.command.split('/').pop(), rssKiB: p.rssKiB })) }
    results.push(result)
    console.log(`${name}: ${(result.diskBytes / 1048576).toFixed(1)} MiB on disk; ${(physicalBytes / 1048576).toFixed(1)} MiB physical footprint across ${processes.length} processes`)
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
    await sleep(2000)
    if (pid && table().some(p => p.pid === pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    opener.kill('SIGTERM')
  }
}
writeFileSync(join(reportDir, 'comparison.json'), JSON.stringify({
  note: 'One idle sample per build on the same Mac and cloned project data. WebKit helpers are attributed using the macOS responsible-process PID. Other applications are excluded. Not a general performance guarantee.', results
}, null, 2))
console.log('Reports:', reportDir)
