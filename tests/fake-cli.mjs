#!/usr/bin/env node
// CLI falso para los tests: imita el comportamiento de los procesos de Claude/Codex sin red ni cuota.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_MODE || 'replay'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let stdin = ''
const appServer = process.argv[2] === 'app-server'
const received = []
const record = () => {
  if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), stdin, received, env: process.env }))
}
const rawOut = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const threadId = 'fake-live-thread'
const turnId = 'fake-live-turn'
const emit = (d) => {
  if (!appServer) return rawOut(d)
  const p = { threadId, turnId }
  if (d.type === 'thread.started') return
  if (d.type === 'turn.started') return
  if (d.type === 'turn.completed') {
    const u = d.usage || {}
    const total = { inputTokens: u.input_tokens || 0, cachedInputTokens: u.cached_input_tokens || 0, outputTokens: u.output_tokens || 0, reasoningOutputTokens: u.reasoning_output_tokens || 0 }
    rawOut({ method: 'thread/tokenUsage/updated', params: { ...p, tokenUsage: { total, last: total } } })
    return rawOut({ method: 'turn/completed', params: { ...p, turn: { id: turnId, status: 'completed' } } })
  }
  if (d.type.startsWith('item.')) {
    const i = d.item
    const names = { agent_message: 'agentMessage', command_execution: 'commandExecution', file_change: 'fileChange', mcp_tool_call: 'mcpToolCall', web_search: 'webSearch' }
    return rawOut({ method: d.type.replace('.', '/'), params: { ...p, item: { ...i, type: names[i.type] || i.type, exitCode: i.exit_code, aggregatedOutput: i.aggregated_output } } })
  }
}
process.stdin.setEncoding('utf8')
if (appServer) {
  await new Promise((ready) => {
    createInterface({ input: process.stdin }).on('line', (line) => {
      const d = JSON.parse(line)
      received.push(d)
      if (d.method === 'initialize') rawOut({ id: d.id, result: {} })
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(d.method)) rawOut({ id: d.id, result: { thread: { id: threadId } } })
      if (d.method === 'turn/start') {
        stdin = d.params.input[0].text
        record()
        rawOut({ id: d.id, result: { turn: { id: turnId } } })
        rawOut({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
        ready()
      }
      if (d.method === 'turn/steer') {
        record()
        if (process.env.FAKE_REJECT_STEER) rawOut({ id: d.id, error: { code: -32000, message: 'Turn is no longer active' } })
        else rawOut({ id: d.id, result: { turnId } })
      }
    })
  })
} else {
  process.stdin.on('data', (d) => { stdin += d; record() })
  const streaming = process.argv.includes('stream-json') && process.argv[process.argv.indexOf('--input-format') + 1] === 'stream-json'
  await new Promise((r) => {
    process.stdin.on('end', r)
    if (streaming) process.stdin.on('data', () => stdin.includes('\n') && r())
  })
  record()
}
if (process.env.FAKE_HOLD_MS) await sleep(Number(process.env.FAKE_HOLD_MS))

// cambia ficheros de la carpeta de trabajo, como haría el agente (null = borrar)
if (process.env.FAKE_WRITE) for (const [f, c] of Object.entries(JSON.parse(process.env.FAKE_WRITE))) c === null ? rmSync(f, { force: true }) : writeFileSync(f, c)

if (mode === 'replay') {
  for (const line of readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    emit(JSON.parse(line))
    await sleep(2)
  }
  process.exit(0)
}

if (mode === 'fail') {
  process.stderr.write('Reading additional input from stdin...\n')
  process.stderr.write('error: algo salió mal en el CLI\n')
  process.exit(2)
}

if (mode === 'hang') {
  // lanza un "nieto" (como un comando del agente) y se queda esperando
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  if (process.env.FAKE_STUBBORN) process.on('SIGTERM', () => {})
  writeFileSync(process.env.FAKE_PIDFILE, String(child.pid))
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'hang-session', model: 'fake' }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Trabajando' } } }) + '\n')

  setInterval(() => {}, 1000)
}

if (mode === 'orch') {
  // Agente de equipo: responde en el formato del CLI que imita (Codex si argv empieza por "exec")
  const codex = appServer || process.argv[2] === 'exec'
  const out = emit
  const reply = (text, structured) => {
    if (codex) {
      out({ type: 'thread.started', thread_id: 'fake-' + Math.random().toString(36).slice(2) })
      out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: structured ? JSON.stringify(structured) : text } })
      out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })
    } else {
      out({ type: 'system', subtype: 'init', session_id: 'fake-' + Math.random().toString(36).slice(2), model: 'fake' })
      if (structured) out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'so', name: 'StructuredOutput', input: structured }] } })
      out({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
      out({ type: 'result', subtype: 'success', is_error: false, usage: {}, structured_output: structured ?? null })
    }
  }
  const state = process.env.FAKE_STATE
  if (stdin.includes('PROPONENTE') && process.env.FAKE_FAIL_PROPOSAL === (codex ? 'codex' : 'claude')) {
    // propuesta que no es un plan: ese agente "no pudo proponer"
    reply('no sé por dónde empezar')
  } else if (stdin.includes('PLANIFICADOR') || stdin.includes('PROPONENTE')) {
    reply('plan', {
      summary: 'Tres piezas: dos en paralelo y una que las une',
      testCommand: 'npm test',
      tasks: [
        { id: 'T1', title: 'Parte de Claude', description: 'Crea T1.txt', assignee: 'claude', dependsOn: [], acceptance: 'existe T1.txt' },
        { id: 'T2', title: 'Parte de Codex', description: 'Crea T2.txt', assignee: 'codex', dependsOn: [], acceptance: 'existe T2.txt' },
        { id: 'T3', title: 'Unir', description: 'Crea T3.txt usando T1 y T2', assignee: 'claude', dependsOn: ['T1', 'T2'], acceptance: 'existe T3.txt' }
      ]
    })
  } else if (stdin.includes('AUTOR DEL RESUMEN')) {
    reply('Resumen: hecho entre los dos, revisado y con las pruebas superadas.')
  } else if (stdin.includes('REVISOR FINAL') && process.env.FAKE_FINAL_CHANGES && !existsSync(join(state, 'final-once'))) {
    writeFileSync(join(state, 'final-once'), '1')
    reply('cambios', { verdict: 'changes', summary: 'Falta el fichero final', issues: [{ severity: 'alta', file: 'final.txt', description: 'Crea final.txt' }] })
  } else if (stdin.includes('revisión final pide ajustes')) {
    writeFileSync(join(process.cwd(), 'final.txt'), 'ajuste final\n')
    reply('He creado final.txt')
  } else if (stdin.includes('REVISOR')) {
    const flag = state && join(state, 'reviewed-once')
    if (process.env.FAKE_REVIEW_CHANGES_ONCE && stdin.includes('REVISOR del trabajo') && flag && !existsSync(flag)) {
      writeFileSync(flag, '1')
      reply('cambios', { verdict: 'changes', summary: 'Falta algo', issues: [{ severity: 'alta', file: 'fix.txt', description: 'Crea fix.txt' }] })
    } else reply('ok', { verdict: 'approve', summary: 'Correcto', issues: [] })
  } else if (stdin.includes('pide cambios')) {
    writeFileSync(join(process.cwd(), 'fix.txt'), 'corregido\n')
    reply('He creado fix.txt')
  } else {
    const key = stdin.match(/TU TAREA \(([^)]+)\)/)?.[1] ?? 'X'
    // la tarea que une comprueba que ha recibido el trabajo del otro agente
    const seen = ['T1.txt', 'T2.txt'].filter((f) => existsSync(join(process.cwd(), f)))
    writeFileSync(join(process.cwd(), `${key}.txt`), `hecho por ${codex ? 'codex' : 'claude'}; veo: ${seen.join(',')}\n`)
    reply(`Hecho ${key}`)
  }
  process.exit(0)
}
