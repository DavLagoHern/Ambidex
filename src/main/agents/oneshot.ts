import type { AgentId } from '@shared/types'
import { prettyCodexError } from './codex'
import { ManagedProcess } from './runner'
import { parseJson } from './types'

// Ejecución de un solo disparo y sin herramientas (mensajes de commit, resúmenes…).
// `prompt` es siempre texto de la app; el contenido variable (diffs) va por stdin.
export async function oneShot(o: {
  agent: AgentId
  bin: string
  cwd: string
  prompt: string
  stdin: string
  model?: string
  env: NodeJS.ProcessEnv
}): Promise<string> {
  const model = o.model ? [o.agent === 'claude' ? '--model' : '-m', o.model] : []
  const args =
    o.agent === 'claude'
      ? ['--output-format', 'text', '--permission-mode', 'plan', '--tools', '', '--no-session-persistence', ...model, '-p', o.prompt]
      : ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-c', 'sandbox_mode="read-only"', ...model, o.prompt]

  let out = ''
  let lastMsg = ''
  let err = ''
  const proc = new ManagedProcess(
    { bin: o.bin, args, cwd: o.cwd, env: o.env, stdin: o.stdin },
    {
      onStdout: (line) => {
        if (o.agent === 'claude') out += line + '\n'
        else {
          const d = parseJson(line)
          if (d?.type === 'item.completed' && d.item?.type === 'agent_message') lastMsg = d.item.text
          if (d?.type === 'turn.failed') err = prettyCodexError(d.error?.message)
        }
      },
      onStderr: (line) => {
        if (!/Reading additional input|OAuth|oauth/.test(line)) err += line + '\n'
      }
    }
  )
  const timer = setTimeout(() => proc.cancel(), 180000)
  const exit = await proc.done
  clearTimeout(timer)
  const result = (o.agent === 'codex' ? lastMsg : out).trim()
  if (result) return result
  throw new Error(err.trim().split('\n').slice(-3).join('\n') || `Salida vacía (código ${exit.code ?? exit.signal})`)
}
