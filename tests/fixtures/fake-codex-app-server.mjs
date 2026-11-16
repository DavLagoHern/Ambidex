#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const log = value => { if (process.env.FAKE_RPC_LOG) appendFileSync(process.env.FAKE_RPC_LOG, JSON.stringify(value) + '\n') }
const requests = JSON.parse(process.env.FAKE_APPROVAL_REQUESTS || '[]')
const pending = new Map()
let finished = false, completion
const finish = (status = 'completed') => {
  if (finished) return
  finished = true
  clearTimeout(completion)
  send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status } } })
}

createInterface({ input: process.stdin }).on('line', line => {
  const d = JSON.parse(line)
  log(d)
  if (d.method === 'initialize') send({ id: d.id, result: { userAgent: 'fake-codex' } })
  else if (['thread/start', 'thread/resume', 'thread/fork'].includes(d.method)) send({ id: d.id, result: { thread: { id: 'thread-test' } } })
  else if (d.method === 'turn/start') {
    send({ id: d.id, result: { turn: { id: 'turn-test' } } })
    send({ method: 'turn/started', params: { threadId: 'thread-test', turn: { id: 'turn-test' } } })
    for (const r of requests) {
      if (r.item) send({ method: 'item/started', params: { threadId: 'thread-test', item: r.item } })
      const params = { threadId: 'thread-test', turnId: 'turn-test', itemId: 'item-test', conversationId: 'thread-test', callId: 'call-test', ...r.params }
      pending.set(r.id, params)
      const request = { id: r.id, method: r.method, params }
      send(request)
      if (process.env.FAKE_APPROVAL_DUPLICATE === 'late') setTimeout(() => send(request), 5)
      else if (process.env.FAKE_APPROVAL_DUPLICATE) send(request)
    }
    const mode = process.env.FAKE_APPROVAL_END
    if (mode === 'resolved') {
      setTimeout(() => {
        for (const id of pending.keys()) send({ method: 'serverRequest/resolved', params: { threadId: 'thread-test', requestId: id } })
        finish()
      }, 10)
    } else if (mode === 'turn-ended') setTimeout(finish, 10)
    else if (mode === 'immediate-end') finish()
    else if (mode === 'process-exited') setTimeout(() => process.exit(0), 10)
    else if (!requests.length) finish()
  } else if (d.method === 'turn/interrupt') {
    send({ id: d.id, result: {} })
    for (const id of pending.keys()) send({ method: 'serverRequest/resolved', params: { threadId: 'thread-test', requestId: id } })
    finish('interrupted')
  } else if (d.method === 'turn/steer') send({ id: d.id, result: { turnId: 'turn-test' } })
  else if (d.method && d.id !== undefined) send({ id: d.id, error: { code: -32601, message: 'Not implemented in fixture' } })
  else if (d.id !== undefined && !d.method) {
    pending.delete(d.id)
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-test', requestId: d.id } })
    if (!pending.size && !finished) completion = setTimeout(() => finish(['cancel', 'abort'].includes(d.result?.decision) ? 'interrupted' : 'completed'), 10)
  }
}).on('close', () => process.exit(0))
