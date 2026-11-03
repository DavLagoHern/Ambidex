#!/usr/bin/env node
// CLI falso para los tests: imita el comportamiento de los procesos de Claude/Codex sin red ni cuota.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.FAKE_MODE || 'replay'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (stdin += d))
await new Promise((r) => process.stdin.on('end', r))

if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), stdin, env: process.env }))

// cambia ficheros de la carpeta de trabajo, como haría el agente (null = borrar)
if (process.env.FAKE_WRITE) for (const [f, c] of Object.entries(JSON.parse(process.env.FAKE_WRITE))) c === null ? rmSync(f, { force: true }) : writeFileSync(f, c)

if (mode === 'replay') {
  for (const line of readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    process.stdout.write(line + '\n')
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
  writeFileSync(process.env.FAKE_PIDFILE, String(child.pid))
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'hang-session', model: 'fake' }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Trabajando' } } }) + '\n')
  // ignora SIGTERM para comprobar la escalada a SIGKILL si FAKE_STUBBORN=1
  if (process.env.FAKE_STUBBORN) process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}

if (mode === 'orch') {
  // Agente de equipo: responde en el formato del CLI que imita (Codex si argv empieza por "exec")
  const codex = process.argv[2] === 'exec'
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
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
