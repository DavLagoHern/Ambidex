import { useEffect, useMemo, useState } from 'react'
import type { AgentId, ExtItem, Extensions } from '@shared/types'
import { AGENT_NAMES } from '@shared/types'
import { api } from '../lib/api'
import { activeStore, toast } from '../lib/app-store'
import { errMsg } from '../lib/utils'
import { AgentLogo, Icon, IconName } from './Icons'
import { Markdown } from './Markdown'

const KINDS: { kind: ExtItem['kind']; label: string; icon: IconName; open: boolean }[] = [
  { kind: 'plugin', label: 'Plugins', icon: 'layers', open: true },
  { kind: 'mcp', label: 'Servidores MCP', icon: 'database', open: true },
  { kind: 'agent', label: 'Subagentes', icon: 'bot', open: true },
  { kind: 'command', label: 'Comandos y prompts', icon: 'command', open: true },
  { kind: 'hook', label: 'Hooks', icon: 'zap', open: true },
  { kind: 'instructions', label: 'Instrucciones (CLAUDE.md, AGENTS.md)', icon: 'file', open: true },
  { kind: 'skill', label: 'Skills', icon: 'sparkles', open: false }
]

// sin la cabecera YAML, que ya se ve como nombre y descripción
const body = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')

function Row({ item, onRead }: { item: ExtItem; onRead: (i: ExtItem) => void }) {
  const readable = item.path?.endsWith('.md')
  return (
    <div className={`ext-row ${item.enabled === false ? 'off' : ''}`}>
      <div className="ext-main">
        <div className="ext-title">
          <b>{item.name}</b>
          <span className="ext-source">{item.source}</span>
          {item.enabled === false && <span className="ext-off">desactivado</span>}
        </div>
        {item.detail && <div className="ext-detail mono">{item.detail}</div>}
        {item.description && <div className="ext-desc muted small">{item.description}</div>}
      </div>
      {item.path && (
        <span className="row-actions always">
          {readable && (
            <button className="icon-btn" title="Leer" onClick={() => onRead(item)}>
              <Icon.file size={13} />
            </button>
          )}
          <button className="icon-btn" title="Mostrar en Finder" onClick={() => api.extensions.reveal(item.path!).catch((e) => toast(errMsg(e), 'error'))}>
            <Icon.folder size={13} />
          </button>
        </span>
      )}
    </div>
  )
}

export function ExtensionsSection() {
  const [agent, setAgent] = useState<AgentId>('claude')
  const [data, setData] = useState<Extensions | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(KINDS.map((k) => [k.kind, k.open])))
  const [reading, setReading] = useState<{ item: ExtItem; text: string } | null>(null)
  const project = activeStore()?.state.meta.path

  const load = () => {
    setData(null)
    api.extensions
      .list(project)
      .then(setData)
      .catch((e) => toast(errMsg(e), 'error'))
  }
  useEffect(load, [project])

  const items = data?.[agent] ?? []
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => (q ? items.filter((i) => `${i.name} ${i.description ?? ''} ${i.source}`.toLowerCase().includes(q)) : items), [items, q])
  const count = (a: AgentId, k: ExtItem['kind']) => (data?.[a] ?? []).filter((i) => i.kind === k).length

  const read = (item: ExtItem) =>
    api.extensions
      .read(item.path!)
      .then((text) => setReading({ item, text }))
      .catch((e) => toast(errMsg(e), 'error'))

  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <div className="seg">
          {(['claude', 'codex'] as AgentId[]).map((a) => (
            <button key={a} className={agent === a ? 'on' : ''} onClick={() => setAgent(a)}>
              <AgentLogo agent={a} size={12} /> {AGENT_NAMES[a]}
              {data && <span className="count">{count(a, 'plugin')} plugins · {count(a, 'skill')} skills · {count(a, 'mcp')} MCP</span>}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Volver a leer" onClick={load}>
          <Icon.refresh size={13} />
        </button>
      </div>
      <input className="input" placeholder="Buscar por nombre, descripción u origen…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
      {!data && (
        <div className="muted small">
          <Icon.spinner size={12} className="spin" /> Leyendo la configuración…
        </div>
      )}
      {data?.errors.map((e) => (
        <div key={e} className="error-text small">
          {e}
        </div>
      ))}
      {data &&
        KINDS.map(({ kind, label, icon }) => {
          const group = shown.filter((i) => i.kind === kind)
          if (!group.length) return null
          const I = Icon[icon]
          const isOpen = open[kind] || !!q
          return (
            <div key={kind} className="ext-group">
              <button className="ext-group-head" onClick={() => setOpen((o) => ({ ...o, [kind]: !isOpen }))}>
                {isOpen ? <Icon.chevronDown size={12} /> : <Icon.chevronRight size={12} />}
                <I size={13} /> {label} <span className="count">{group.length}</span>
              </button>
              {isOpen && group.map((i, n) => <Row key={`${i.source}:${i.name}:${n}`} item={i} onRead={read} />)}
            </div>
          )
        })}
      {data && !shown.length && <div className="muted small">{q ? 'Nada coincide con la búsqueda.' : `${AGENT_NAMES[agent]} no tiene extensiones instaladas.`}</div>}
      <p className="muted small" style={{ marginTop: 14 }}>
        Solo se leen tus ficheros de configuración ({agent === 'claude' ? '~/.claude, ~/.claude.json' : '~/.codex'} y los del proyecto abierto). De los servidores MCP se enseña el tipo y el comando o la dirección, nunca variables de
        entorno, cabeceras ni tokens. Para instalar o quitar, usa {agent === 'claude' ? '/plugin en Claude Code' : 'codex plugin'} en una terminal.
      </p>
      {reading && (
        <div className="overlay center" onMouseDown={() => setReading(null)}>
          <div className="ext-reader" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ext-reader-head">
              <b>{reading.item.name}</b>
              <span className="ext-source">{reading.item.source}</span>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" title="Cerrar (Esc)" onClick={() => setReading(null)}>
                <Icon.x size={14} />
              </button>
            </div>
            <div className="mono tiny muted ellipsis" style={{ padding: '0 16px 8px' }}>
              {reading.item.path}
            </div>
            <div className="ext-reader-body">
              <Markdown text={body(reading.text)} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
