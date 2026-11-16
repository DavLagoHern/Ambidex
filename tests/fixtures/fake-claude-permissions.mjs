#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const log = value => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(value) + '\n') }
let started = false, replied = false
const background = process.env.FAKE_CLAUDE_BACKGROUND === '1'
const result = tokens => send({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: tokens }, result: 'Listo' })
const finish = () => {
  result(background ? 20 : 10)
  if (background) send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
}
const request = () => {
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'printf AMBIDEX_PERMISSION' } }] } })
  send({ type: 'control_request', request_id: 'permission-1', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'printf AMBIDEX_PERMISSION' },
    agent_id: background ? 'worker-1' : undefined,
    permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'printf AMBIDEX_PERMISSION' }] }]
  } })
  if (process.env.FAKE_CLAUDE_CANCEL_REQUEST) setTimeout(() => {
    send({ type: 'control_cancel_request', request_id: 'permission-1' }); finish()
  }, 20)
}
createInterface({ input: process.stdin }).on('line', line => {
  const d = JSON.parse(line); log(d)
  if (d.type === 'user' && !started) {
    started = true
    log({ argv: process.argv.slice(2) })
    send({ type: 'system', subtype: 'init', session_id: 'fake-claude-permission', model: 'fake' })
    if (background) {
      send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'worker-1' }] })
      result(10)
      setTimeout(request, 35)
    } else request()
  } else if (d.type === 'control_response' && !replied) {
    replied = true
    const response = d.response.response
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: response.behavior === 'allow' ? 'AMBIDEX_PERMISSION' : response.message, is_error: response.behavior !== 'allow' }] } })
    send({ type: 'assistant', message: { content: [{ type: 'text', text: response.behavior === 'allow' ? 'Permitido' : 'Denegado' }] } })
    finish()
  }
}).on('close', () => { log({ stdinClosed: true, replied }); process.exit(0) })
