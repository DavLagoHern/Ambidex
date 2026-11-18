#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const result = tokens => send({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: tokens }, result: 'Listo' })
const mode = process.env.FAKE_LIFECYCLE_MODE
let started = false
createInterface({ input: process.stdin }).on('line', () => {
  if (started) return
  started = true
  if (mode === 'foreground') {
    for (const id of ['typecheck', 'build']) {
      send({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_bash', is_backgrounded: false })
      send({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' })
    }
    result(10)
  } else if (mode === 'foreground-without-notification') {
    send({ type: 'system', subtype: 'task_started', task_id: 'bash', task_type: 'local_bash', is_backgrounded: false })
    result(10)
  } else if (mode === 'ignore-eof') {
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
    result(10)
  } else {
    send({ type: 'system', subtype: 'task_started', task_id: 'worker', is_backgrounded: true })
    result(10)
    setTimeout(() => {
      send({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: mode === 'failed-task' ? 'failed' : mode === 'stopped-task' ? 'stopped' : 'completed' })
      // Una notificación tardía o una foto vieja no resucitan la tarea.
      send({ type: 'system', subtype: 'task_started', task_id: 'worker', is_backgrounded: true })
      send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'worker', status: 'running' }] })
    }, 35)
  }
}).on('close', () => {
  if (mode === 'ignore-eof') return
  // El resultado final puede llegar después de que el host cierre stdin.
  result(20)
  setTimeout(() => process.exit(0), 5)
})
