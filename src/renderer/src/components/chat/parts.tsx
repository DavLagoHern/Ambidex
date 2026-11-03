import { KeyboardEvent as ReactKeyboardEvent, memo, RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentId, ChatItem, ClaudeMode, CodexSandbox, Permission, QueuedMessage, RunInfo } from '@shared/types'
import { AGENT_NAMES, DEFAULT_PROMPTS, UNRESTRICTED } from '@shared/types'
import { api } from '../../lib/api'
import { attempt, confirmAsync, saveSettings, setApp, toast, useApp } from '../../lib/app-store'
import { SessionView, usePS, useStore } from '../../lib/project-store'
import { basename, durationText, errMsg, fmtTokens, fuzzyScore, relPath, toolName } from '../../lib/utils'
import { AgentLogo, Icon } from '../Icons'
import { Markdown } from '../Markdown'
import { imageMenu } from '../../lib/image-menu'

export const CLAUDE_MODES: { id: ClaudeMode; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan', hint: 'Solo lectura: analiza y propone' },
  { id: 'acceptEdits', label: 'Editar', hint: 'Edita ficheros; lo que requiere permiso se deniega' },
  { id: 'auto', label: 'Auto', hint: 'Un clasificador permite lo seguro y bloquea lo arriesgado' },
  { id: 'dontAsk', label: 'No preguntar', hint: 'Deniega todo lo que necesitaría permiso' },
  { id: 'manual', label: 'Manual', hint: 'Solo lo permitido en tu configuración de Claude Code' },
  { id: 'bypassPermissions', label: 'Sin límites', hint: 'Sin pedir permiso para nada: puede ejecutar y cambiar lo que quiera' }
]
export const CODEX_SANDBOX: { id: CodexSandbox; label: string; hint: string }[] = [
  { id: 'read-only', label: 'Solo lectura', hint: 'No puede modificar ficheros' },
  { id: 'workspace-write', label: 'Workspace', hint: 'Puede editar dentro de la carpeta de trabajo' },
  { id: 'danger-full-access', label: 'Acceso total', hint: 'Sin sandbox: puede ejecutar y cambiar lo que quiera' }
]
const EFFORT_LABELS: Record<string, string> = {
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  xhigh: 'Muy alto',
  max: 'Máximo',
  ultra: 'Ultra',
  ultracode: 'Ultracode',
  minimal: 'Mínimo'
}

// ---------- elementos del chat ----------

function ToolRow({ item, cwd }: { item: Extract<ChatItem, { type: 'tool' }>; cwd: string }) {
  const [open, setOpen] = useState(false)
  const input = item.input.split(cwd + '/').join('')
  return (
    <div className={`tool tool-${item.status} ${open ? 'open' : ''}`}>
      <button className="tool-head" onClick={() => item.output && setOpen(!open)}>
        <span className="tool-status">
          {item.status === 'running' ? <Icon.spinner size={13} className="spin" /> : item.status === 'error' ? <Icon.fail size={13} /> : <Icon.ok size={13} />}
        </span>
        <span className="tool-name">{toolName(item.name)}</span>
        <span className="tool-input mono ellipsis" title={item.input}>
          {input}
        </span>
        {item.output && <Icon.chevronRight size={12} className="tool-chevron" />}
      </button>
      {open && item.output && <pre className="tool-output">{item.output}</pre>}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Icon.brain size={12} /> Razonamiento <Icon.chevronRight size={11} className="tool-chevron" />
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  )
}

export function ContextChipView({ context }: { context: string }) {
  if (context.includes('<conversacion_previa>'))
    return (
      <span className="msg-context" title="Se le pasó lo que se habló con el otro agente">
        <Icon.workflow size={11} /> con contexto del otro agente
      </span>
    )
  const m = context.match(/Fichero abierto(?: en el editor)?: ([^\s(<]+)(?: \(líneas (\d+-\d+))?/)
  return (
    <span className="msg-context" title={context}>
      <Icon.file size={11} /> {m ? `${basename(m[1])}${m[2] ? ` · L${m[2]}` : ''}` : 'contexto'}
    </span>
  )
}

// Las respuestas JSON (planes, revisiones) se muestran legibles
function StructuredView({ data }: { data: any }) {
  if (data && typeof data.verdict === 'string')
    return (
      <div className={`review-card ${data.verdict}`}>
        <b>{data.verdict === 'approve' ? '✓ Aprobado' : '✎ Pide cambios'}</b> {data.summary}
        {Array.isArray(data.issues) &&
          data.issues.map((i: any, k: number) => (
            <div key={k} className="small">
              · [{i.severity}] {i.file ? <span className="mono">{i.file}</span> : null} {i.description}
            </div>
          ))}
      </div>
    )
  if (data && Array.isArray(data.tasks))
    return (
      <div className="review-card">
        <b>Plan:</b> {data.summary}
        {data.tasks.map((t: any) => (
          <div key={t.id} className="small">
            · {t.id} ({t.assignee}) {t.title}
          </div>
        ))}
      </div>
    )
  return null
}

function tryJson(text: string): unknown {
  const t = text.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

// ---------- deshacer un turno ----------

// Enseña exactamente qué ficheros se tocarían y pide confirmación antes de cambiar nada
async function undoTurn(run: RunInfo) {
  const plan = await attempt(() => api.sessions.undoPreview(run.id))
  if (!plan) return
  const doIt = plan.files.filter((f) => f.action !== 'conflict')
  const keep = plan.files.filter((f) => f.action === 'conflict')
  if (!doIt.length) return toast('No queda nada que deshacer: los ficheros de este turno han cambiado después', 'info')
  const detail = [
    ...doIt.slice(0, 14).map((f) => `${f.action === 'delete' ? 'Borrar' : 'Restaurar'}  ${f.path}`),
    doIt.length > 14 ? `… y ${doIt.length - 14} más` : '',
    keep.length ? `\nNo se tocan porque cambiaron después: ${keep.map((f) => f.path).slice(0, 6).join(', ')}${keep.length > 6 ? '…' : ''}` : '',
    plan.overlapping ? '\nOjo: otro agente trabajó a la vez en esta carpeta; lo que cambió en ese rato también se deshace.' : ''
  ]
    .filter(Boolean)
    .join('\n')
  if (!(await confirmAsync(`¿Deshacer ${doIt.length === 1 ? 'el cambio' : `los ${doIt.length} cambios`} de este turno?`, detail, true))) return
  const r = await attempt(() => api.sessions.undo(run.id))
  if (r) toast(`Deshecho: ${r.restored.length} restaurados, ${r.deleted.length} borrados${r.skipped.length ? `, ${r.skipped.length} sin tocar` : ''}`, 'success')
}

// Lo último que dijo el agente en un turno (su respuesta), para copiarla
export const finalAnswer = (items: ChatItem[]): string | undefined => {
  const a = items.findLast((i) => i.type === 'assistant')
  return a && a.type === 'assistant' && a.text.trim() ? a.text : undefined
}

// Copia un texto al portapapeles y avisa
export async function copyText(text: string, what = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text)
    toast(what, 'success')
  } catch (e) {
    toast(`No se pudo copiar: ${errMsg(e)}`, 'error')
  }
}

// Botón de copiar: pasa a «Copiado» un instante
export function CopyButton({ text, label, title = 'Copiar', className = 'btn ghost small' }: { text: string; label?: string; title?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={className}
      title={title}
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        } catch (err) {
          toast(`No se pudo copiar: ${errMsg(err)}`, 'error')
        }
      }}
    >
      {done ? <Icon.check size={12} /> : <Icon.copy size={12} />} {done ? 'Copiado' : label}
    </button>
  )
}

// Al final de cada turno: copiar la respuesta y, si cambió ficheros (solo en repositorios de Git, que es donde se
// hacen las fotos), deshacer los cambios
export function TurnUndo({ sessionId, at, answer }: { sessionId: string; at: number; answer?: string }) {
  const run = useStore((s) => s.runs.find((r) => r.sessionId === sessionId && r.startedAt === at))
  if (!run?.undo && !answer) return null
  return (
    <div className={`turn-undo ${run?.undo === 'done' ? 'done' : ''}`}>
      {answer && <CopyButton text={answer} label="Copiar respuesta" title="Copiar la respuesta (en Markdown)" />}
      {run?.undo === 'done' && (
        <>
          <Icon.undo size={11} /> Cambios de este turno deshechos
        </>
      )}
      {run?.undo === 'available' && (
        <button className="btn ghost small" title="Vuelve los ficheros a como estaban antes de este turno (te enseña cuáles antes de hacerlo)" onClick={() => undoTurn(run)}>
          <Icon.undo size={12} /> Deshacer los cambios de este turno
        </button>
      )}
    </div>
  )
}

// Imágenes de un mensaje ya enviado: se leen de la carpeta de adjuntos una vez y se guardan en memoria
const imageCache = new Map<string, Promise<string>>()
function SentImage({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    if (!imageCache.has(path)) imageCache.set(path, api.attachments.read(path))
    imageCache.get(path)!.then(
      (u) => alive && setUrl(u),
      () => (imageCache.delete(path), alive && setMissing(true))
    )
    return () => {
      alive = false
    }
  }, [path])
  if (missing) return <span className="sent-img missing">imagen no disponible</span>
  return (
    <button className="sent-img" title="Ver la imagen (clic derecho: copiar)" onClick={() => url && setApp({ lightbox: url })} onContextMenu={(e) => imageMenu(e, url, { view: true })}>
      {url && <img src={url} alt="" draggable={false} />}
    </button>
  )
}

export function SentImages({ paths }: { paths?: string[] }) {
  if (!paths?.length) return null
  return (
    <div className="sent-imgs">
      {paths.map((p) => (
        <SentImage key={p} path={p} />
      ))}
    </div>
  )
}

export const Item = memo(function Item({ item, session }: { item: ChatItem; session: SessionView }) {
  const ps = usePS()
  switch (item.type) {
    case 'user':
      return (
        <div className="msg-user-wrap">
          <SentImages paths={item.images} />
          <div className="msg-user-line">
            <CopyButton text={item.text} title="Copiar el mensaje" className="icon-btn msg-copy" />
            <div className="msg-user">{item.text}</div>
          </div>
          {item.context && <ContextChipView context={item.context} />}
        </div>
      )
    case 'assistant': {
      const json = !item.streaming ? tryJson(item.text) : undefined
      if (json && (typeof (json as any).verdict === 'string' || Array.isArray((json as any).tasks))) return <StructuredView data={json} />
      return (
        <div className={`msg-assistant agent-${session.agent} ${item.streaming ? 'streaming' : ''}`}>
          <Markdown text={item.text} />
        </div>
      )
    }
    case 'thinking':
      return <Thinking text={item.text} />
    case 'tool':
      return <ToolRow item={item} cwd={session.cwd} />
    case 'files':
      return (
        <div className="files-card">
          <div className="files-card-head">
            <Icon.fileEdit size={13} /> {item.files.length} fichero{item.files.length === 1 ? '' : 's'} modificado{item.files.length === 1 ? '' : 's'}
          </div>
          {item.files.map((f) => {
            const repo = ps.repoFor(f.path)
            return (
              <div key={f.path} className="file-row" onClick={() => ps.openDiff(repo, relPath(repo, f.path), 'head')} title="Ver diff respecto a HEAD">
                <span className="file-name ellipsis">
                  {basename(f.path)} <span className="muted small">{relPath(session.cwd, f.path)}</span>
                </span>
                <span className="row-actions">
                  <button className="icon-btn" title="Abrir fichero" onClick={(e) => (e.stopPropagation(), ps.openFile(f.path))}>
                    <Icon.file size={12} />
                  </button>
                </span>
                <span className="badge">{f.change}</span>
              </div>
            )
          })}
        </div>
      )
    case 'todo':
      return (
        <div className="todo">
          {item.items.map((t, i) => (
            <div key={i} className={t.done ? 'done' : ''}>
              {t.done ? <Icon.ok size={12} /> : <span className="todo-dot" />} {t.text}
            </div>
          ))}
        </div>
      )
    case 'usage': {
      const u = item.usage
      return (
        <div className="usage-line">
          {fmtTokens(u.inputTokens)} entrada · {fmtTokens(u.outputTokens)} salida
          {u.reasoningTokens ? <> ({fmtTokens(u.reasoningTokens)} razonamiento)</> : null} · {fmtTokens(u.cachedTokens)} caché
          {u.durationMs ? <> · {durationText(u.durationMs)}</> : null}
          {u.numTurns ? <> · {u.numTurns} pasos</> : null}
        </div>
      )
    }
    case 'permission':
      return (
        <div className="permission-card">
          <div className="permission-head">
            <Icon.shield size={14} /> {AGENT_NAMES[session.agent]} necesitaba permiso y se le ha denegado
          </div>
          {item.denials.map((d, i) => (
            <div key={i} className="mono small ellipsis">
              {d.tool}: {d.input}
            </div>
          ))}
          <div className="muted small">Cambia el modo de permisos (selector con el escudo) si quieres permitirlo, y vuelve a pedírselo.</div>
        </div>
      )
    case 'notice':
      return <div className="notice">{item.text}</div>
    case 'error':
      return (
        <div className="msg-error">
          <Icon.alert size={14} />
          <span>{item.text}</span>
        </div>
      )
  }
})

// ---------- turno terminado: los pasos intermedios en una sola fila ----------

type Step = Extract<ChatItem, { type: 'tool' | 'thinking' | 'assistant' }>
type TurnEntry = { kind: 'item'; item: ChatItem } | { kind: 'steps'; key: string; steps: Step[] }

// Mientras trabaja se ve todo; al acabar, herramientas, razonamiento y textos intermedios se pliegan en una fila
// (donde estaba el primero) y queda a la vista la respuesta final con los ficheros, avisos y errores
export function collapseTurn(items: ChatItem[], done: boolean): TurnEntry[] {
  if (!done) return items.map((item) => ({ kind: 'item', item }))
  const final = items.findLast((i) => i.type === 'assistant')
  const out: TurnEntry[] = []
  let group: Extract<TurnEntry, { kind: 'steps' }> | null = null
  for (const it of items) {
    if ((it.type === 'tool' || it.type === 'thinking' || it.type === 'assistant') && it !== final) {
      if (!group) {
        group = { kind: 'steps', key: `steps-${it.id}`, steps: [] }
        out.push(group)
      }
      group.steps.push(it)
    } else out.push({ kind: 'item', item: it })
  }
  // un único paso no merece plegarse
  return out.flatMap<TurnEntry>((e) => (e.kind === 'steps' && e.steps.length === 1 ? [{ kind: 'item' as const, item: e.steps[0] }] : [e]))
}

const Steps = memo(function Steps({ steps, session }: { steps: Step[]; session: SessionView }) {
  const [open, setOpen] = useState(false)
  const tools = steps.filter((s): s is Extract<Step, { type: 'tool' }> => s.type === 'tool')
  const failed = tools.filter((t) => t.status === 'error').length
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(toolName(t.name), (counts.get(toolName(t.name)) ?? 0) + 1)
  const summary = [...counts].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  const label = tools.length ? `${tools.length} ${tools.length === 1 ? 'acción' : 'acciones'}` : `${steps.length} pasos`
  return (
    <div className={`steps ${open ? 'open' : ''}`}>
      <button className="steps-head" onClick={() => setOpen(!open)} title={open ? 'Ocultar los pasos' : 'Ver los pasos de este turno'}>
        <Icon.chevronRight size={12} className="tool-chevron" />
        <span className="steps-label">{label}</span>
        {summary.length > 0 && <span className="steps-summary ellipsis">{summary.join(' · ')}</span>}
        {failed > 0 && (
          <span className="steps-failed">
            <Icon.fail size={11} /> {failed}
          </span>
        )}
      </button>
      {open && (
        <div className="steps-body">
          {steps.map((it) => (
            <Item key={it.id} item={it} session={session} />
          ))}
        </div>
      )}
    </div>
  )
})

export function TurnItems({ items, session, done }: { items: ChatItem[]; session: SessionView; done: boolean }) {
  const entries = useMemo(() => collapseTurn(items, done), [items, done])
  return (
    <>
      {entries.map((e) => (e.kind === 'steps' ? <Steps key={e.key} steps={e.steps} session={session} /> : <Item key={e.item.id} item={e.item} session={session} />))}
    </>
  )
}

export function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="tabular">{durationText(Date.now() - since)}</span>
}

// Indicador "trabajando" con la herramienta en curso, tiempo y botón de parar
export function Working({ session }: { session: SessionView }) {
  const ps = usePS()
  const run = useStore((s) => s.runs.find((r) => r.sessionId === session.id && r.status === 'running'))
  const lastTool = session.items?.findLast?.((i) => i.type === 'tool') as Extract<ChatItem, { type: 'tool' }> | undefined
  return (
    <div className="working">
      <span className={`pulse agent-${session.agent}`} />
      <span>{lastTool?.status === 'running' ? `${toolName(lastTool.name)}…` : `${AGENT_NAMES[session.agent]} está trabajando…`}</span>
      {run && (
        <span className="muted">
          · <Elapsed since={run.startedAt} />
        </span>
      )}
      <button className="btn ghost small" onClick={() => ps.cancelSession(session.id)}>
        <Icon.stop size={11} /> Detener
      </button>
    </div>
  )
}

// ---------- composer ----------

export function useAutosize(ref: RefObject<HTMLTextAreaElement>, text: string) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [text])
}

export function ContextChip() {
  const ps = usePS()
  const includeContext = useStore((s) => s.includeContext)
  const activeTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTab))
  if (activeTab?.kind !== 'file') return null
  return (
    <button className={`chip ${includeContext ? 'on' : ''}`} title="Adjuntar el fichero abierto (y la selección) como contexto" onClick={() => ps.set({ includeContext: !includeContext })}>
      <Icon.clip size={11} /> {basename(activeTab.path)}
    </button>
  )
}

interface Mention {
  value: string
  label: string
  detail?: string
  agent?: AgentId
  prompt?: string // texto que sustituye a /nombre
  manage?: boolean
}

// Autocompletado de @ficheros (y @claude/@codex en el chat con los dos) y de /prompts al principio del mensaje
export function useMentions(ta: RefObject<HTMLTextAreaElement>, text: string, setText: (t: string) => void, withAgents: boolean) {
  const ps = usePS()
  const prompts = useApp((s) => s.settings?.prompts ?? DEFAULT_PROMPTS)
  const [files, setFiles] = useState<string[]>([])
  const [caret, setCaret] = useState(0)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const slash = text.slice(0, caret).match(/^\/([\w-]*)$/)?.[1]
  const token = slash ?? text.slice(0, caret).match(/(^|\s)@([\w./-]*)$/)?.[2]
  const open = token !== undefined && dismissed !== `${caret}:${token}`

  useEffect(() => {
    if (open && slash === undefined && !files.length) ps.fileList().then(setFiles)
  }, [open])

  const items: Mention[] = useMemo(() => {
    if (!open) return []
    const q = (token ?? '').toLowerCase()
    if (slash !== undefined) {
      const found = prompts
        .map((p) => [p, fuzzyScore(p.name, q)] as const)
        .filter(([, sc]) => sc >= 0)
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => ({ value: p.id, label: `/${p.name}`, detail: p.text, prompt: p.text }))
      return [...found, { value: '__manage', label: 'Gestionar prompts…', detail: 'Ajustes → Prompts', manage: true }]
    }
    const agents: Mention[] = withAgents
      ? (['claude', 'codex'] as AgentId[]).filter((a) => a.startsWith(q)).map((a) => ({ value: a, label: AGENT_NAMES[a], detail: 'enviar a este agente', agent: a }))
      : []
    const fl = files
      .map((f) => [f, fuzzyScore(f, q)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f]) => ({ value: f, label: basename(f), detail: f }))
    return [...agents, ...fl]
  }, [open, token, files, withAgents, prompts])

  const insert = (m: Mention) => {
    if (m.manage) return setText(text.slice(caret)), setApp({ overlay: 'settings', settingsSection: 'prompts' })
    const before = m.prompt !== undefined ? m.prompt : text.slice(0, caret).replace(/@([\w./-]*)$/, `@${m.value} `)
    setText(before + text.slice(caret))
    setSel(0)
    requestAnimationFrame(() => {
      ta.current?.focus()
      ta.current?.setSelectionRange(before.length, before.length)
      setCaret(before.length)
    })
  }

  const onKeyDown = (e: ReactKeyboardEvent): boolean => {
    if (!open || !items.length) return false
    if (e.key === 'ArrowDown') return e.preventDefault(), setSel((sel + 1) % items.length), true
    if (e.key === 'ArrowUp') return e.preventDefault(), setSel((sel - 1 + items.length) % items.length), true
    if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), insert(items[Math.min(sel, items.length - 1)]), true
    if (e.key === 'Escape') return e.preventDefault(), setDismissed(`${caret}:${token}`), true
    return false
  }

  const popup =
    open && items.length ? (
      <div className="mentions">
        {items.map((m, i) => (
          <div key={m.value} className={`menu-item ${i === sel ? 'selected' : ''}`} onMouseDown={(e) => (e.preventDefault(), insert(m))} onMouseEnter={() => setSel(i)}>
            <span>
              {m.agent ? <AgentLogo agent={m.agent} size={12} /> : m.prompt !== undefined ? <Icon.zap size={12} /> : m.manage ? <Icon.settings size={12} /> : <Icon.file size={12} />}{' '}
              {m.label}
            </span>
            <span className="muted small ellipsis">{m.detail}</span>
          </div>
        ))}
      </div>
    ) : null

  return { popup, onKeyDown, trackCaret: () => setCaret(ta.current?.selectionStart ?? 0) }
}

// ---------- imágenes adjuntas ----------

export interface Attachment {
  path: string // en la carpeta de adjuntos de la app
  url: string // para enseñarla
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

// Una imagen pegada o soltada se reduce (como mucho 2000 px de lado) antes de guardarla: los agentes no necesitan más
async function prepareImage(file: Blob): Promise<{ data: Uint8Array; mime: string; url: string }> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height))
  let blob: Blob = file
  if (scale < 1 || !IMAGE_MIMES.includes(file.type) || file.size > 3_500_000) {
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)))
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    blob = await c.convertToBlob({ type: 'image/png' })
    if (blob.size > 3_500_000) blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  }
  bmp.close()
  return { data: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, url: URL.createObjectURL(blob) }
}

export function useAttachments() {
  const [images, setImages] = useState<Attachment[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const add = async (files: Blob[]) => {
    for (const f of files.filter((x) => x.type.startsWith('image/'))) {
      try {
        const p = await prepareImage(f)
        const path = await api.attachments.save(p.data, p.mime)
        setImages((l) => [...l, { path, url: p.url }].slice(0, 10))
      } catch (e) {
        toast(`No se pudo adjuntar la imagen: ${errMsg(e)}`, 'error')
      }
    }
  }
  const strip = images.length ? (
    <div className="attach-strip">
      {images.map((i) => (
        <div key={i.path} className="attach" onContextMenu={(e) => imageMenu(e, i.url, { view: true })}>
          <img src={i.url} alt="" draggable={false} />
          <button className="attach-x" title="Quitar" onClick={() => setImages((l) => l.filter((x) => x.path !== i.path))}>
            <Icon.x size={10} />
          </button>
        </div>
      ))}
    </div>
  ) : null
  const button = (
    <>
      <button className="icon-btn attach-btn" title="Adjuntar imágenes (también puedes pegarlas o arrastrarlas)" onClick={() => picker.current?.click()}>
        <Icon.image size={14} />
      </button>
      <input
        ref={picker}
        type="file"
        accept={IMAGE_MIMES.join(',')}
        multiple
        hidden
        onChange={(e) => {
          add([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
    </>
  )
  return {
    paths: images.length ? images.map((i) => i.path) : undefined,
    count: images.length,
    add,
    addReady: (a: Attachment[]) => setImages((l) => [...l, ...a].slice(0, 10)),
    clear: () => setImages([]),
    onPaste: (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
      if (!files.length) return
      e.preventDefault()
      add(files)
    },
    strip,
    button
  }
}

// Texto del mensaje: con solo imágenes, una frase para que el agente sepa qué hacer con ellas
export const messageText = (text: string, images?: string[]) => text.trim() || (images?.length ? 'Mira la imagen adjunta.' : '')

// Otras partes del proyecto (la Web, el editor…) dejan texto o imágenes en el cuadro de texto del chat para revisarlo
// y enviarlo. Lo recoge el primer cuadro visible de ese proyecto; si no hay ninguno, devuelve false.
interface ComposerInsert {
  projectId: string
  text?: string
  images?: Attachment[]
  claimed: boolean
}

export function insertIntoComposer(projectId: string, payload: { text?: string; images?: Attachment[] }): boolean {
  const detail: ComposerInsert = { projectId, ...payload, claimed: false }
  window.dispatchEvent(new CustomEvent('composer-insert', { detail }))
  return detail.claimed
}

export function useComposerInsert(ta: RefObject<HTMLTextAreaElement>, setText: (fn: (t: string) => string) => void, addImages?: (a: Attachment[]) => void) {
  const ps = usePS()
  useEffect(() => {
    const onInsert = (e: Event) => {
      const d = (e as CustomEvent<ComposerInsert>).detail
      if (d.claimed || d.projectId !== ps.id || !ta.current?.offsetParent) return
      d.claimed = true
      const add = d.text
      if (add) setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${add}` : add))
      if (d.images?.length) addImages?.(d.images)
      requestAnimationFrame(() => {
        const el = ta.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
        el.scrollTop = el.scrollHeight
      })
    }
    window.addEventListener('composer-insert', onInsert)
    return () => window.removeEventListener('composer-insert', onInsert)
  }, [ps])
}

// Ficheros soltados en el cuadro de texto → menciones @ruta (las imágenes, adjuntas si el cuadro las admite)
export function useFileDrop(setText: (fn: (t: string) => string) => void, onImages?: (files: File[]) => void) {
  const ps = usePS()
  const [over, setOver] = useState(false)
  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const ws = ps.state.workspace
        const all = [...e.dataTransfer.files]
        const imgs = onImages ? all.filter((f) => IMAGE_MIMES.includes(f.type)) : []
        if (imgs.length) onImages!(imgs)
        const refs = all
          .filter((f) => !imgs.includes(f))
          .map((f) => '@' + relPath(ws, api.pathForFile(f)))
          .join(' ')
        if (refs) setText((t) => (t && !t.endsWith(' ') ? t + ' ' : t) + refs + ' ')
      }
    }
  }
}

// Modelo, razonamiento y permisos de un agente: de la conversación si existe, si no los valores por defecto
// Nombre corto de un modelo para los chips: «Opus 5.5», «GPT-6.1-Sol»
export function useModelLabel() {
  const infos = useApp((s) => s.agentInfo)
  return (agent: AgentId, id: string) => (infos.find((i) => i.agent === agent)?.models.find((m) => m.id === id)?.label ?? id).replace(/^Claude /, '')
}

// `unified`: el chat único. Con el modelo según la dificultad, «Auto» deja que lo elija cada mensaje y solo se
// ofrecen los modelos permitidos; con el razonamiento automático, «Auto · Medio» igual. Sin conversación de ese
// agente aún, lo que elijas se guarda en `pin` hasta el primer mensaje.
export function AgentPills({
  agent,
  session,
  compact,
  unified,
  pin
}: {
  agent: AgentId
  session?: SessionView
  compact?: boolean
  unified?: boolean
  pin?: { model: string; effort: string; set: (key: 'model' | 'effort', value: string) => void }
}) {
  const ps = usePS()
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.agentInfo.find((i) => i.agent === agent))
  const policy = settings?.modelPolicy
  const auto = !!unified && !!policy?.auto
  const autoEffort = !!unified && policy?.autoEffort !== false
  const patch = (key: 'model' | 'effort' | 'permission', value: string) => {
    if (key === 'model' && auto && !session && pin) pin.set('model', value)
    else if (key === 'effort' && autoEffort && !session && pin) pin.set('effort', value)
    else if (session) ps.updateSession(session.id, { [key]: value })
    else {
      const map = {
        model: agent === 'claude' ? 'claudeModel' : 'codexModel',
        effort: agent === 'claude' ? 'claudeEffort' : 'codexEffort',
        permission: agent === 'claude' ? 'claudeMode' : 'codexSandbox'
      } as const
      saveSettings({ [map[key]]: value })
    }
  }
  const model = session ? (session.model ?? '') : auto && pin ? pin.model : ((agent === 'claude' ? settings?.claudeModel : settings?.codexModel) ?? '')
  const models = auto ? (info?.models ?? []).filter((m) => !m.id || m.id === model || policy![agent].allowed.includes(m.id)) : info?.models
  const effort = session ? (session.effort ?? '') : autoEffort && pin ? pin.effort : ((agent === 'claude' ? settings?.claudeEffort : settings?.codexEffort) ?? '')
  const permission: Permission | undefined = session?.permission ?? (agent === 'claude' ? settings?.claudeMode : settings?.codexSandbox)
  const modelInfo = info?.models.find((m) => m.id === model) ?? info?.models[0]
  const efforts = modelInfo?.efforts ?? []
  const modes = agent === 'claude' ? CLAUDE_MODES : CODEX_SANDBOX
  const mode = modes.find((m) => m.id === permission)
  return (
    <>
      <label className="pill" title={auto && !model ? 'Auto: el modelo se elige en cada mensaje según su dificultad (Ajustes → Modelos)' : `Modelo de ${AGENT_NAMES[agent]}`}>
        <Icon.cpu size={12} />
        <select value={model} onChange={(e) => patch('model', e.target.value)}>
          {models?.map((m) => (
            <option key={m.id} value={m.id}>
              {auto && !m.id ? 'Auto' : m.label}
            </option>
          ))}
          {model && !info?.models.some((m) => m.id === model) && <option value={model}>{model}</option>}
        </select>
      </label>
      <label
        className="pill"
        title={
          autoEffort && !effort
            ? 'Auto: medio por defecto. Jev lo sube a alto solo si ve clara una tarea difícil (o lo baja con una sencilla); los niveles por encima de alto solo si los eliges tú'
            : 'Nivel de razonamiento: más alto = mejor en tareas difíciles, más lento y consume más límite'
        }
      >
        <Icon.brain size={12} />
        <select value={effort} onChange={(e) => patch('effort', e.target.value)}>
          <option value="">
            {autoEffort ? 'Auto · Medio' : compact ? 'Razonamiento' : `Razonamiento${modelInfo?.defaultEffort ? ` (${EFFORT_LABELS[modelInfo.defaultEffort] ?? modelInfo.defaultEffort})` : ''}`}
          </option>
          {efforts.map((x) => (
            <option key={x} value={x}>
              {EFFORT_LABELS[x] ?? x}
            </option>
          ))}
        </select>
      </label>
      <label className={`pill ${permission && UNRESTRICTED.includes(permission) ? 'unrestricted' : ''}`} title={mode?.hint}>
        <Icon.shield size={12} />
        <select value={permission} onChange={(e) => patch('permission', e.target.value)}>
          {modes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}

// Mensajes en cola: se envían solos cuando el agente queda libre
export function QueueList({ items }: { items: QueuedMessage[] }) {
  const ps = usePS()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const threads = useStore((s) => s.threads)
  const sessions = useStore((s) => s.sessions)
  if (!items.length) return null
  // quién trabaja en la conversación del mensaje: «al turno actual» va a ese y «al otro» al contrario
  const roles = (q: QueuedMessage) => {
    const t = q.threadId ? threads[q.threadId] : undefined
    if (!t) return undefined
    const busy = (['claude', 'codex'] as AgentId[]).filter((a) => t.sessions[a] && sessions[t.sessions[a]!]?.running)
    const current = q.agent && busy.includes(q.agent) ? q.agent : busy[0]
    if (!current) return undefined
    return { current, other: (current === 'claude' ? 'codex' : 'claude') as AgentId }
  }
  return (
    <div className="queue">
      <div className="queue-head">
        <Icon.clock size={12} /> En cola · {items.length} <span className="muted">si no eliges, Jev lo reparte cuando quede libre</span>
      </div>
      {items.map((q, i) => {
        const r = roles(q)
        return (
        <div key={q.id} className="queue-item">
          <span className="queue-n">{i + 1}</span>
          {q.agent && <AgentLogo agent={q.agent} size={12} />}
          {editing === q.id ? (
            <input
              autoFocus
              className="queue-edit"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => (draft.trim() && draft !== q.prompt && ps.updateQueued(q.id, draft.trim()), setEditing(null))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="queue-text ellipsis" title="Clic para editar" onClick={() => (setEditing(q.id), setDraft(q.prompt))}>
              {q.prompt}
            </span>
          )}
          <button className="icon-btn" title={r ? `Añadir al turno de ${AGENT_NAMES[r.current]} sin detenerlo` : 'Enviar ya'} onClick={() => ps.sendQueuedNow(q.id)}>
            <Icon.send size={12} />
          </button>
          {r && (
            <button className="icon-btn" title={`Mandárselo a ${AGENT_NAMES[r.other]}`} onClick={() => ps.sendQueuedNow(q.id, 'other')}>
              <AgentLogo agent={r.other} size={12} />
            </button>
          )}
          <button className="icon-btn" title="Quitar de la cola" onClick={() => ps.removeQueued(q.id)}>
            <Icon.x size={12} />
          </button>
        </div>
        )
      })}
    </div>
  )
}
