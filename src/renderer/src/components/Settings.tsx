import { ReactNode, useEffect, useState } from 'react'
import type { AgentId, AgentInfo, AgentModelPolicy, AppInfo, ClaudeMode, CliUpdate, CodexSandbox, JevTest, ModelTier, RouteCategory, SavedPrompt, Settings as S, Theme } from '@shared/types'
import { AGENT_NAMES, DEFAULT_MODEL_POLICY, DEFAULT_PROMPTS, DEFAULT_ROUTE_PREFS } from '@shared/types'
import { ORCH_MODES, OrchMode } from '@shared/orchestrator'
import { CATEGORY_LABELS, DEFAULT_CATEGORIES, DIFFICULTY_CRITERIA, difficultyCriteria, routeCategories, TIER_LABELS } from '@shared/router'
import { api } from '../lib/api'
import { confirmAsync, refreshAgents, restartToUpdate, saveSettings, setApp, toast, useApp } from '../lib/app-store'
import { COMMANDS } from '../lib/commands'
import { timeAgo, uid } from '../lib/utils'
import { ExtensionsSection } from './Extensions'
import { AgentLogo, Icon, IconName } from './Icons'

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: 'agents', label: 'Agentes y cuentas', icon: 'bot' },
  { id: 'extensions', label: 'Extensiones', icon: 'layers' },
  { id: 'router', label: 'Motor de enrutado', icon: 'zap' },
  { id: 'models', label: 'Modelos', icon: 'cpu' },
  { id: 'team', label: 'Equipo', icon: 'workflow' },
  { id: 'permissions', label: 'Permisos', icon: 'shield' },
  { id: 'prompts', label: 'Prompts', icon: 'zap' },
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'appearance', label: 'Apariencia', icon: 'palette' },
  { id: 'shortcuts', label: 'Atajos', icon: 'keyboard' },
  { id: 'data', label: 'Datos locales', icon: 'database' }
]

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

// Fila con lápiz: a la vista solo el nombre (y sus controles); al editar, también la descripción que lee Jev para
// decidir. Así se afina a qué llama Jev «depurar», «difícil»… o se añaden casos propios.
function CriterionRow({
  label,
  description,
  hint,
  placeholder,
  labelEditable = true,
  startEditing = false,
  onSave,
  onRemove,
  onReset,
  children
}: {
  label: string
  description: string
  hint?: ReactNode
  placeholder?: string
  labelEditable?: boolean
  startEditing?: boolean
  onSave: (v: { label: string; description: string }) => void
  onRemove?: () => void
  onReset?: () => void
  children?: ReactNode
}) {
  const [editing, setEditing] = useState(startEditing)
  const [name, setName] = useState(label)
  const [desc, setDesc] = useState(description)
  const open = () => (setName(label), setDesc(description), setEditing(true))
  const save = () => {
    if (!name.trim()) return toast('Ponle un nombre', 'error')
    onSave({ label: name.trim(), description: desc.trim() })
    setEditing(false)
  }
  return (
    <div className={`set-row crit-row ${editing ? 'editing' : ''}`}>
      <div className="crit-main">
        <div className="set-label">
          <div className="crit-name">
            {label}
            <button className="icon-btn crit-pencil" title="Editar el nombre y la descripción que lee Jev" onClick={() => (editing ? setEditing(false) : open())}>
              <Icon.edit size={12} />
            </button>
          </div>
          {hint && <div className="muted small">{hint}</div>}
        </div>
        {children && <div className="set-control">{children}</div>}
      </div>
      {editing && (
        <div className="crit-form">
          {labelEditable && <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre" autoFocus />}
          <textarea
            className="input"
            rows={3}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={placeholder ?? 'Cuándo aplica, con ejemplos. Jev lo lee para decidir (en español o en inglés).'}
            autoFocus={!labelEditable}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && save()}
          />
          <div className="row gap">
            <button className="btn small primary" onClick={save}>
              Guardar
            </button>
            <button className="btn small ghost" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <span style={{ flex: 1 }} />
            {onReset && (
              <button className="btn small ghost" onClick={() => (onReset(), setEditing(false))} title="Volver al texto de serie">
                Restaurar
              </button>
            )}
            {onRemove && (
              <button className="btn small danger-text" onClick={onRemove}>
                <Icon.trash size={12} /> Quitar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Tipos de tarea del enrutado: a quién va cada uno y, con el lápiz, su nombre y descripción; se pueden añadir y quitar
function CategoriesSection({ settings, set }: { settings: S; set: (p: Partial<S>) => void }) {
  const cats = routeCategories(settings)
  const prefs = { ...DEFAULT_ROUTE_PREFS, ...(settings.routePrefs ?? {}) }
  const [added, setAdded] = useState<string | null>(null)
  const saveCats = (next: typeof cats) => set({ routeCategories: next })
  const builtin = (id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id)
  const custom = settings.routeCategories?.length
  return (
    <>
      <div className="set-sub">Quién atiende cada tipo de tarea (tus preferencias)</div>
      <p className="muted small crit-note">
        El lápiz enseña la descripción que lee Jev para reconocer cada tipo: afínala con tus casos o añade tipos nuevos. Con el motor «Reglas» solo cuentan los de serie (por palabras clave).
      </p>
      {cats.map((c) => (
        <CriterionRow
          key={c.id}
          label={c.label}
          description={c.description}
          startEditing={added === c.id}
          onSave={(v) => (saveCats(cats.map((x) => (x.id === c.id ? { ...x, ...v } : x))), setAdded(null))}
          onReset={builtin(c.id) ? () => saveCats(cats.map((x) => (x.id === c.id ? builtin(c.id)! : x))) : undefined}
          onRemove={
            cats.length > 1
              ? async () => (await confirmAsync(`¿Quitar «${c.label}»?`, 'Jev dejará de usar este tipo de tarea.')) && saveCats(cats.filter((x) => x.id !== c.id))
              : undefined
          }
        >
          <div className="seg">
            {(['claude', 'any', 'codex'] as const).map((a) => (
              <button key={a} className={(prefs[c.id] ?? 'any') === a ? 'on' : ''} onClick={() => set({ routePrefs: { ...prefs, [c.id]: a } })}>
                {a === 'any' ? 'El más libre' : AGENT_NAMES[a]}
              </button>
            ))}
          </div>
        </CriterionRow>
      ))}
      <div className="row gap crit-actions">
        <button
          className="btn small"
          onClick={() => {
            const id = `c-${uid().slice(0, 8)}`
            saveCats([...cats, { id, label: 'Nuevo tipo de tarea', description: '' }])
            setAdded(id)
          }}
        >
          <Icon.plus size={12} /> Añadir tipo de tarea
        </button>
        {custom ? (
          <button
            className="btn small ghost"
            onClick={async () => (await confirmAsync('¿Recuperar los tipos de serie?', 'Se pierden los nombres, descripciones y tipos que hayas añadido.')) && set({ routeCategories: undefined })}
          >
            Recuperar los de serie
          </button>
        ) : null}
      </div>
    </>
  )
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={checked} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} />
}

const MB = (n: number) => `${Math.round(n / 1048576)} MB`

// Un prompt guardado: se guarda al salir de cada campo
function PromptRow({ p, onSave, onDelete }: { p: SavedPrompt; onSave: (patch: Partial<SavedPrompt>) => void; onDelete: () => void }) {
  const [name, setName] = useState(p.name)
  const [text, setText] = useState(p.text)
  useEffect(() => {
    setName(p.name)
    setText(p.text)
  }, [p.name, p.text])
  const commit = () => {
    const n = name.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || p.name
    setName(n)
    if (n !== p.name || text !== p.text) onSave({ name: n, text })
  }
  return (
    <div className="prompt-row">
      <label className="prompt-name">
        <span className="muted">/</span>
        <input className="input" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} onBlur={commit} aria-label="Nombre" />
      </label>
      <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} aria-label="Texto" />
      <button className="icon-btn" title="Borrar este prompt" onClick={onDelete}>
        <Icon.trash size={13} />
      </button>
    </div>
  )
}

function PromptsSection() {
  const prompts = useApp((s) => s.settings?.prompts ?? DEFAULT_PROMPTS)
  const save = (list: SavedPrompt[]) => saveSettings({ prompts: list })
  return (
    <>
      <div className="prompt-list">
        {prompts.map((p) => (
          <PromptRow
            key={p.id}
            p={p}
            onSave={(patch) => save(prompts.map((x) => (x.id === p.id ? { ...x, ...patch } : x)))}
            onDelete={() => save(prompts.filter((x) => x.id !== p.id))}
          />
        ))}
        {!prompts.length && <div className="muted small">No tienes prompts guardados.</div>}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={() => save([...prompts, { id: uid(), name: `prompt-${prompts.length + 1}`, text: '' }])}>
          <Icon.plus size={13} /> Nuevo prompt
        </button>
        <button className="btn ghost" onClick={() => save([...DEFAULT_PROMPTS, ...prompts.filter((p) => !DEFAULT_PROMPTS.some((d) => d.id === p.id))])}>
          Recuperar los de serie
        </button>
      </div>
    </>
  )
}

// Jev: modelo local de decisiones para el enrutado. Se instala solo si el usuario lo pide.
function JevCard({ active }: { active: boolean }) {
  const j = useApp((s) => s.jev)
  const settings = useApp((s) => s.settings)
  const [busy, setBusy] = useState(false)
  const [sample, setSample] = useState('El botón de pagar no funciona en el móvil')
  const [test, setTest] = useState<JevTest | null>(null)
  useEffect(() => {
    api.jev
      .status()
      .then((s) => setApp({ jev: s }))
      .catch(() => {})
  }, [])
  if (!j) return null
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const p = j.progress
  const labels: Record<string, string> = { ...CATEGORY_LABELS, ...Object.fromEntries(routeCategories(settings ?? {}).map((c) => [c.id, c.label])) }
  const top = test
    ? (Object.entries(test.probabilities) as [RouteCategory, number][])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : []
  return (
    <div className={`jev-card ${active ? 'on' : ''}`}>
      <div className="row gap">
        <Icon.zap size={16} className="jev-icon" />
        <b>Jev</b>
        <span className="muted small">{j.release} · local · MIT</span>
        <span style={{ flex: 1 }} />
        <span className={`status-chip jev-${j.state}`}>
          {
            {
              unsupported: 'No disponible',
              missing: 'Sin instalar',
              installing: 'Instalando…',
              stopped: 'Listo (arranca al usarlo)',
              starting: 'Arrancando…',
              ready: `Activo${j.lastMs !== undefined ? ` · ${j.lastMs} ms` : ''}`,
              error: 'Error'
            }[j.state]
          }
        </span>
      </div>
      <p className="muted small">
        Un modelo pequeño (≈0,9B) hecho solo para decidir: lee tu mensaje y lo último de la conversación y responde qué tipo de tarea es y si continúa lo anterior.
        Funciona en tu Mac, sin cuota ni internet; arriba ves lo que tardó la última vez. Tus preferencias de abajo deciden a quién va cada tipo de tarea.
      </p>
      {j.state === 'unsupported' && <p className="small">Jev solo publica versión para Mac con Apple Silicon.</p>}
      {j.state === 'missing' && (
        <div className="row gap wrap">
          <button className="btn primary" disabled={busy} onClick={() => act(() => api.jev.install().then((s) => setApp({ settings: s })))}>
            <Icon.down size={13} /> Instalar Jev (≈650 MB)
          </button>
          <span className="muted small">
            Se descarga de{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), api.openExternal(j.source))}>
              github.com/feder-cr/jev
            </a>
            , se verifica con SHA-256 y solo escucha en tu Mac.
          </span>
        </div>
      )}
      {j.state === 'installing' && p && (
        <div className="jev-progress">
          <div className="row gap">
            <span className="small">{p.label}</span>
            <span style={{ flex: 1 }} />
            {p.total > 0 && (
              <span className="muted small tabular">
                {MB(p.done)} / {MB(p.total)}
              </span>
            )}
            <button className="btn small" onClick={() => api.jev.cancel()}>
              Cancelar
            </button>
          </div>
          <div className="meter big">
            <span className={`meter-fill ${p.total ? '' : 'indeterminate'}`} style={{ width: p.total ? `${Math.min(100, (p.done / p.total) * 100)}%` : '35%' }} />
          </div>
        </div>
      )}
      {j.installed && j.state !== 'installing' && (
        <>
          <div className="row gap wrap">
            <input className="input" style={{ flex: 1, minWidth: 200 }} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Escribe un mensaje de ejemplo" />
            <button className="btn" disabled={busy || !sample.trim()} onClick={() => act(() => api.jev.test(sample).then(setTest))}>
              {busy ? <Icon.spinner size={13} className="spin" /> : <Icon.zap size={13} />} Probar
            </button>
            {j.state === 'ready' && (
              <button className="btn" onClick={() => act(() => api.jev.stop())} title="Libera su memoria; vuelve a arrancar solo al siguiente mensaje">
                Detener
              </button>
            )}
            <button
              className="btn danger-text"
              disabled={busy}
              onClick={async () => (await confirmAsync('¿Eliminar Jev?', 'Se borra el modelo de tu Mac. El enrutado vuelve a las reglas.', true)) && act(() => api.jev.remove().then((s) => setApp({ settings: s })))}
            >
              Eliminar
            </button>
          </div>
          {test && (
            <div className="jev-test small">
              <b>{test.category ? (labels[test.category] ?? test.category) : 'Sin un tipo claro'}</b>
              {test.confidence !== undefined && <span className="muted"> · confianza {Math.round(test.confidence * 100)}%</span>}
              {' · '}
              <b>{test.tier ? `Tarea ${TIER_LABELS[test.tier]}` : 'Dificultad dudosa'}</b>
              {test.tierConfidence !== undefined && <span className="muted"> {Math.round(test.tierConfidence * 100)}%</span>}
              <span className="muted"> · {test.ms} ms</span>
              <div className="muted">{top.map(([c, v]) => `${labels[c] ?? c} ${Math.round(v * 100)}%`).join(' · ')}</div>
            </div>
          )}
          <p className="muted small">Mientras está activo usa ≈1 GB de memoria; se detiene solo tras 10 minutos sin mensajes.</p>
        </>
      )}
      {j.error && (
        <p className="small error-text">
          <Icon.warn size={12} /> {j.error}
        </p>
      )}
    </div>
  )
}

const UPDATE_CHIP: Record<CliUpdate['state'], string> = {
  checking: 'muted',
  current: 'ok',
  updated: 'ok',
  available: 'warn',
  waiting: 'warn',
  behind: 'muted',
  updating: 'running',
  manual: 'muted',
  missing: 'muted',
  error: 'error'
}

// Actualización de Ambidex: lo que está haciendo y, con una versión lista, reiniciar
function AppUpdateRow({ settings, set }: { settings: S; set: (p: Partial<S>) => void }) {
  const u = useApp((s) => s.appUpdate)
  const [checking, setChecking] = useState(false)
  const busy = checking || u?.state === 'checking' || u?.state === 'pulling' || u?.state === 'building'
  const n = u?.commits ?? 0
  const text = !u
    ? ''
    : {
        off: u.message ?? 'Esta instalación no se actualiza sola',
        idle: 'Se comprobará en unos segundos',
        checking: 'Buscando en GitHub…',
        current: 'Al día: tienes la última versión',
        pulling: `Descargando ${n} cambio${n === 1 ? '' : 's'} nuevo${n === 1 ? '' : 's'}…`,
        building: u.message ?? 'Compilando…',
        ready: `Ambidex ${u.version ?? ''} lista${n ? ` (${n} cambio${n === 1 ? '' : 's'})` : ''}: se instala al reiniciar o al cerrar la app`,
        blocked: u.message ?? 'No se puede actualizar sola',
        error: `No se pudo actualizar: ${u.message ?? 'error desconocido'}`
      }[u.state]
  return (
    <Row
      label="Actualizar Ambidex"
      hint="Al abrir la app (y cada 6 horas) trae lo último de GitHub (git pull), lo compila en segundo plano y lo instala al reiniciar. Si el clon tiene cambios tuyos, no toca nada y te avisa. Registro en logs/update.log."
    >
      <div className="app-update">
        <div className="row gap">
          {u?.state === 'ready' ? (
            <button className="btn small primary" onClick={restartToUpdate}>
              <Icon.refresh size={12} /> Reiniciar ahora
            </button>
          ) : (
            u?.state !== 'off' && (
              <button
                className="btn small"
                disabled={busy}
                onClick={() => {
                  setChecking(true)
                  api.self
                    .check()
                    .catch((e) => toast((e as Error).message, 'error'))
                    .finally(() => setChecking(false))
                }}
              >
                {busy ? <Icon.spinner size={12} className="spin" /> : <Icon.refresh size={12} />} Buscar ahora
              </button>
            )
          )}
          <Switch checked={settings.autoUpdateApp !== false} onChange={(v) => set({ autoUpdateApp: v })} />
        </div>
        {text && (
          <span className={`small app-update-text ${u?.state === 'error' || u?.state === 'blocked' ? 'warn' : 'muted'}`} title={u?.source}>
            {text}
            {u?.checkedAt && !busy ? ` · comprobado ${timeAgo(u.checkedAt / 1000)}` : ''}
          </span>
        )}
      </div>
    </Row>
  )
}

// Versión instalada frente a la publicada, y lo que está haciendo el actualizador
function UpdateLine({ agent }: { agent: AgentId }) {
  const u = useApp((s) => s.cliUpdates[agent])
  const auto = useApp((s) => s.settings?.autoUpdateClis !== false)
  if (!u || u.state === 'missing') return null
  const text: Record<CliUpdate['state'], string> = {
    checking: 'Buscando versiones nuevas…',
    current: `Al día: la ${u.installed} es la última`,
    available: `Hay una versión nueva: ${u.latest}`,
    waiting: `La ${u.latest} se instalará cuando termine el turno en curso`,
    updating: `Instalando la ${u.latest} con ${u.method}…`,
    updated: u.message ?? `Actualizado a la ${u.installed}`,
    behind: u.message ?? '',
    manual: u.message ?? '',
    missing: '',
    error: `No se pudo actualizar: ${u.message ?? 'error desconocido'}`
  }
  return (
    <div className="agent-card-update">
      <span className={`status-chip ${UPDATE_CHIP[u.state]}`}>
        {u.state === 'updating' || u.state === 'checking' ? (
          <Icon.spinner size={11} className="spin" />
        ) : u.state === 'current' || u.state === 'updated' ? (
          <Icon.check size={11} />
        ) : (
          <Icon.refresh size={11} />
        )}
        {u.state === 'updating' ? 'Actualizando' : u.state === 'available' || u.state === 'waiting' ? 'Versión nueva' : u.state === 'error' ? 'Error' : 'Versión'}
      </span>
      <span className="ellipsis" title={text[u.state]}>
        {text[u.state]}
      </span>
      <span style={{ flex: 1 }} />
      {u.checkedAt && u.state !== 'updating' && u.state !== 'checking' && <span className="muted small">comprobado {timeAgo(u.checkedAt / 1000)}</span>}
      {(u.state === 'available' || u.state === 'error' || (u.state === 'behind' && !auto)) && (
        <button className="btn small" onClick={() => api.cli.update(agent).catch((e) => toast((e as Error).message, 'error'))}>
          {u.state === 'available' ? `Actualizar a la ${u.latest}` : 'Reintentar'}
        </button>
      )}
    </div>
  )
}

const TIERS: { id: ModelTier; label: string; hint: string }[] = [
  { id: 'hard', label: 'Difíciles', hint: 'Arquitectura y diseño, errores difíciles de encontrar, refactorizaciones grandes, cambios en muchos ficheros, seguridad, rendimiento, migraciones' },
  { id: 'easy', label: 'Sencillas', hint: 'Preguntas y explicaciones, cambios pequeños en un fichero, renombrar, textos, ejecutar un comando, retoques de estilo' }
]

// Los modelos concretos de cada CLI (sin alias como «opus» ni los ocultos). Los marcados que el CLI instalado no
// ofrece (una versión antigua) se enseñan igual, con aviso.
function choosableModels(info: AgentInfo | undefined, agent: AgentId, p: AgentModelPolicy) {
  const list = (info?.models ?? []).filter((m) => m.id && !m.hidden && (agent === 'codex' || m.id.startsWith('claude-'))).map((m) => ({ id: m.id, label: m.label, missing: false }))
  if (!info) return list
  const extra = [...new Set([...p.allowed, p.hard, p.easy])].filter((id) => !list.some((m) => m.id === id))
  return [...list, ...extra.map((id) => ({ id, label: id, missing: true }))]
}

function ModelPolicyCard({ agent, info, policy, onChange }: { agent: AgentId; info?: AgentInfo; policy: AgentModelPolicy; onChange: (p: AgentModelPolicy) => void }) {
  const rows = choosableModels(info, agent, policy)
  const toggle = (id: string, on: boolean) => {
    const allowed = on ? [...policy.allowed, id] : policy.allowed.filter((x) => x !== id)
    if (!allowed.length) return toast('Deja al menos un modelo marcado', 'info')
    // un tipo de tarea que se queda sin modelo pasa al primero que siga marcado
    const keep = (m: string) => (allowed.includes(m) ? m : allowed[0])
    onChange({ allowed, hard: keep(policy.hard), easy: keep(policy.easy) })
  }
  return (
    <div className={`agent-card agent-${agent} model-card`}>
      <div className="agent-card-head">
        <AgentLogo agent={agent} size={20} />
        <div className="agent-card-name">{AGENT_NAMES[agent]}</div>
        <span className="muted small">{info?.version}</span>
      </div>
      <div className="model-list">
        {!info && <div className="muted small">Detectando los modelos del CLI…</div>}
        {rows.map((m) => {
          const on = policy.allowed.includes(m.id)
          return (
            <div key={m.id} className={`model-row ${on ? 'on' : ''}`}>
              <label className="check model-check">
                <input type="checkbox" checked={on} onChange={(e) => toggle(m.id, e.target.checked)} />
                <span className="model-name">{m.label}</span>
                {m.missing && (
                  <span className="status-chip warn" title="Actualiza el CLI o desmárcalo">
                    No está en tu versión del CLI
                  </span>
                )}
              </label>
              {on && (
                <div className="seg">
                  {TIERS.map((t) => (
                    <button key={t.id} className={policy[t.id] === m.id ? 'on' : ''} title={`Usar ${m.label} para las tareas ${t.label.toLowerCase()}`} onClick={() => onChange({ ...policy, [t.id]: m.id })}>
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ModelsSection({ settings, info }: { settings: S; info: (a: AgentId) => AgentInfo | undefined }) {
  const policy = settings.modelPolicy ?? DEFAULT_MODEL_POLICY
  const save = (patch: Partial<typeof policy>) => saveSettings({ modelPolicy: { ...policy, ...patch } })
  const who =
    settings.routerMode === 'jev'
      ? 'Jev lo estima en la misma consulta en la que elige el agente.'
      : settings.routerMode === 'ai'
        ? 'Claude Haiku lo estima al elegir el agente.'
        : 'Con el motor «Reglas» no se estima: se usa siempre el modelo de las difíciles. Cambia a Jev en Motor de enrutado.'
  return (
    <>
      <p className="muted">
        En el chat único, cada mensaje se clasifica como tarea <b>difícil</b> o <b>sencilla</b> y va al modelo que elijas para ese caso en el agente que lo atienda. Los
        modelos sin marcar no se usan nunca.
      </p>
      <Row label="Elegir el modelo según la dificultad" hint={`${who} Con más del 80 % semanal disponible se usa el modelo de las difíciles; con menos margen decide la dificultad. Sin una estimación segura se usa el ligero. Si fijas un modelo en el selector de una conversación, manda el tuyo.`}>
        <Switch checked={policy.auto} onChange={(v) => save({ auto: v })} />
      </Row>
      <Row
        label="Razonamiento automático"
        hint="Medio por defecto. Solo sube a alto si Jev ve clara una tarea difícil, y baja a bajo con una claramente sencilla. Los niveles por encima de alto (muy alto, máximo) gastan mucho límite: solo se usan si los eliges tú en la conversación."
      >
        <Switch checked={policy.autoEffort !== false} onChange={(v) => save({ autoEffort: v })} />
      </Row>
      <div className="set-sub">Qué es difícil y qué es sencillo</div>
      <p className="muted small crit-note">Decide el modelo y el razonamiento de cada mensaje. El lápiz enseña lo que lee Jev: añade tus casos para afinarlo.</p>
      {TIERS.map((t) => (
        <CriterionRow
          key={t.id}
          label={t.label}
          hint={t.hint}
          labelEditable={false}
          description={difficultyCriteria(settings)[t.id]}
          placeholder="Qué trabajos cuentan como tal, con ejemplos (en español o en inglés)"
          onSave={(v) => saveSettings({ difficultyCriteria: { ...settings.difficultyCriteria, [t.id]: v.description } })}
          onReset={settings.difficultyCriteria?.[t.id] ? () => saveSettings({ difficultyCriteria: { ...settings.difficultyCriteria, [t.id]: DIFFICULTY_CRITERIA[t.id] } }) : undefined}
        />
      ))}
      {policy.auto && (
        <>
          {(['claude', 'codex'] as AgentId[]).map((a) => (
            <ModelPolicyCard key={a} agent={a} info={info(a)} policy={policy[a]} onChange={(p) => save({ [a]: p })} />
          ))}
          <button className="btn ghost" onClick={() => saveSettings({ modelPolicy: { ...DEFAULT_MODEL_POLICY, auto: policy.auto, autoEffort: policy.autoEffort } })}>
            Recuperar los de serie
          </button>
        </>
      )}
    </>
  )
}

function AgentCard({ info, settings }: { info?: AgentInfo; settings: S }) {
  const agent = info?.agent
  const [path, setPath] = useState('')
  const key = agent === 'claude' ? 'claudePath' : 'codexPath'
  useEffect(() => setPath((settings[key] as string) ?? ''), [settings, key])
  if (!info || !agent) return null
  const auth = info.auth
  const ok = !!info.path && !!auth?.loggedIn
  return (
    <div className={`agent-card agent-${agent}`}>
      <div className="agent-card-head">
        <AgentLogo agent={agent} size={22} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="agent-card-name">{AGENT_NAMES[agent]}</div>
          <div className="muted small ellipsis">{info.path ? `${info.version ?? 'versión desconocida'} · ${info.path}` : 'No encontrado'}</div>
        </div>
        <span className={`status-chip ${ok ? 'ok' : 'warn'}`}>{ok ? 'Listo' : !info.path ? 'Sin instalar' : 'Sin sesión'}</span>
      </div>
      {auth?.loggedIn && (
        <div className="agent-card-auth">
          <Icon.key size={13} />
          <span>
            {auth.method}
            {auth.account && <> · {auth.account}</>}
            {auth.plan && <> · plan {auth.plan}</>}
            {auth.org && <> · {auth.org}</>}
          </span>
          <span className="muted small" style={{ marginLeft: 'auto' }}>
            comprobado {timeAgo(auth.checkedAt / 1000)}
          </span>
        </div>
      )}
      <UpdateLine agent={agent} />
      {info.warnings.map((w) => (
        <div key={w} className="agent-card-warn">
          <Icon.warn size={13} /> {w}
        </div>
      ))}
      <div className="row gap" style={{ marginTop: 10 }}>
        {info.path && (
          <button className={`btn ${auth?.loggedIn ? '' : 'primary'}`} onClick={() => setApp({ loginAgent: agent })}>
            <Icon.login size={13} /> {auth?.loggedIn ? 'Cambiar de cuenta' : 'Iniciar sesión'}
          </button>
        )}
        <button className="btn ghost" onClick={() => refreshAgents(true)}>
          <Icon.refresh size={13} /> Volver a comprobar
        </button>
      </div>
      <Row label="Ruta del CLI" hint="Vacío = detectar automáticamente">
        <input
          className="input mono"
          placeholder={info.path || `/opt/homebrew/bin/${agent}`}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onBlur={() => path !== (settings[key] ?? '') && saveSettings({ [key]: path.trim() })}
        />
      </Row>
      <Row label="Modelo por defecto" hint={settings.modelPolicy?.auto !== false ? 'Para las conversaciones con este agente solo. En el chat único lo elige Ajustes → Modelos.' : undefined}>
        <select
          className="select"
          value={(agent === 'claude' ? settings.claudeModel : settings.codexModel) ?? ''}
          onChange={(e) => saveSettings(agent === 'claude' ? { claudeModel: e.target.value } : { codexModel: e.target.value })}
        >
          {info.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Row>
    </div>
  )
}

function Shortcuts() {
  const list = COMMANDS.filter((c) => c.shortcut)
  return (
    <div className="shortcut-list">
      {list.map((c) => (
        <div key={c.id} className="shortcut-row">
          <span>{c.title}</span>
          <kbd>{c.shortcut}</kbd>
        </div>
      ))}
      <div className="shortcut-row">
        <span>Cambiar a la pestaña de proyecto 1–9</span>
        <kbd>⌘1 … ⌘9</kbd>
      </div>
      <div className="shortcut-row">
        <span>Cerrar pestaña del editor</span>
        <kbd>⌘W</kbd>
      </div>
      <div className="shortcut-row">
        <span>Guardar fichero</span>
        <kbd>⌘S</kbd>
      </div>
    </div>
  )
}

function DataSection() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    api.info().then(setInfo)
  }, [])
  return (
    <>
      <p className="muted">
        Proyectos, conversaciones, ejecuciones y preferencias se guardan en una base de datos SQLite local. No se guardan contraseñas ni tokens: la
        autenticación la gestionan los propios CLI.
      </p>
      <Row label="Base de datos" hint={info ? `${(info.dbSize / 1024 / 1024).toFixed(1)} MB` : ''}>
        <div className="row gap">
          <span className="mono small ellipsis">{info?.dbPath}</span>
          <button className="btn small" onClick={() => api.revealData()}>
            Mostrar
          </button>
        </div>
      </Row>
      <Row label="Versión">
        <span className="mono small">
          Ambidex {info?.version} · {info?.runtime} · {info?.webview}
        </span>
      </Row>
    </>
  )
}

export function SettingsModal() {
  const settings = useApp((s) => s.settings)
  const infos = useApp((s) => s.agentInfo)
  const loading = useApp((s) => s.agentsLoading)
  const section = useApp((s) => s.settingsSection)
  const close = () => setApp({ overlay: null })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const jevInstalled = useApp((s) => !!s.jev?.installed)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    api.cli
      .updates()
      .then((list) => setApp((s) => ({ cliUpdates: { ...s.cliUpdates, ...Object.fromEntries(list.map((u) => [u.agent, u])) } })))
      .catch(() => {})
  }, [])
  if (!settings) return null
  const set = (patch: Partial<S>) => saveSettings(patch)
  const info = (a: AgentId) => infos.find((i) => i.agent === a)

  return (
    <div className="overlay center" onMouseDown={close}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-title">Ajustes</div>
          {SECTIONS.map((s) => {
            const I = Icon[s.icon]
            return (
              <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setApp({ settingsSection: s.id })}>
                <I size={14} /> {s.label}
              </button>
            )
          })}
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={close} title="Cerrar (Esc)">
            <Icon.x size={16} />
          </button>
          {section === 'agents' && (
            <>
              <h2>Agentes y cuentas {loading && <Icon.spinner size={14} className="spin muted" />}</h2>
              <p className="muted">
                Ambidex ejecuta los CLI oficiales instalados en tu Mac con las cuentas en las que has iniciado sesión. No usa APIs ni claves.
              </p>
              <Row label="Configurar agentes" hint="Instala, conecta o elige qué agentes aparecen en la aplicación.">
                <button className="btn" onClick={() => setApp({ overlay: null, setupOpen: true })}>Abrir guía de configuración</button>
              </Row>
              <AppUpdateRow settings={settings} set={set} />
              <Row
                label="Instalar las versiones nuevas de los CLI"
                hint="Comprueba cada 6 horas si hay una versión nueva de Claude Code o Codex y la instala con lo mismo con que los instalaste (Homebrew, npm o su instalador). Nunca mientras ese agente está trabajando."
              >
                <div className="row gap">
                  <button
                    className="btn small"
                    disabled={checking}
                    onClick={() => {
                      setChecking(true)
                      api.cli
                        .check()
                        .catch((e) => toast((e as Error).message, 'error'))
                        .finally(() => setChecking(false))
                    }}
                  >
                    {checking ? <Icon.spinner size={12} className="spin" /> : <Icon.refresh size={12} />} Buscar ahora
                  </button>
                  <Switch checked={settings.autoUpdateClis !== false} onChange={(v) => set({ autoUpdateClis: v })} />
                </div>
              </Row>
              <AgentCard info={info('claude')} settings={settings} />
              <AgentCard info={info('codex')} settings={settings} />
            </>
          )}
          {section === 'router' && (
            <>
              <h2>Motor de enrutado</h2>
              <p className="muted">
                En el modo <b>Ambos</b>, cada mensaje va al agente más adecuado según el tipo de tarea, si continúa la conversación, si un agente está ocupado y su uso del
                plan. Con @claude o @codex eliges tú.
              </p>
              <Row
                label="Quién entiende el mensaje"
                hint={
                  settings.routerMode === 'jev'
                    ? jevInstalled
                      ? 'Jev, en tu Mac y sin cuota. Si no contesta a tiempo (1,2 s mientras escribes, 3 s al enviar; por ejemplo, mientras arranca), deciden las reglas.'
                      : 'Jev aún no está instalado: hasta que lo instales, deciden las reglas.'
                    : settings.routerMode === 'ai'
                      ? 'Claude Haiku: entiende bien, pero tarda unos segundos por mensaje y consume un poco de cuota.'
                      : 'Palabras clave: instantáneo pero no entiende la intención.'
                }
              >
                <div className="seg">
                  <button className={settings.routerMode === 'jev' ? 'on' : ''} onClick={() => set({ routerMode: 'jev' })}>
                    Jev (local)
                  </button>
                  <button className={settings.routerMode === 'ai' ? 'on' : ''} onClick={() => set({ routerMode: 'ai' })}>
                    Claude Haiku
                  </button>
                  <button className={settings.routerMode === 'rules' ? 'on' : ''} onClick={() => set({ routerMode: 'rules' })}>
                    Reglas
                  </button>
                </div>
              </Row>
              <JevCard active={settings.routerMode === 'jev'} />
              <CategoriesSection settings={settings} set={set} />
            </>
          )}
          {section === 'models' && (
            <>
              <h2>Modelos</h2>
              <ModelsSection settings={settings} info={info} />
            </>
          )}
          {section === 'team' && (
            <>
              <h2>Equipo</h2>
              <p className="muted">
                Para tareas grandes: un agente planifica, el trabajo se reparte según dependencias, cada uno trabaja en su propio git worktree, se revisan entre ellos,
                se integra, se pasan las pruebas y nada llega a tu rama sin tu aprobación.
              </p>
              <Row label="Modo por defecto">
                <select className="select" value={settings.orchMode} onChange={(e) => set({ orchMode: e.target.value as OrchMode })}>
                  {ORCH_MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Rondas de revisión" hint="Máximo de idas y vueltas revisor → corrección por tarea (evita bucles)">
                <div className="seg">
                  {[1, 2, 3, 4].map((n) => (
                    <button key={n} className={settings.orchMaxRounds === n ? 'on' : ''} onClick={() => set({ orchMaxRounds: n })}>
                      {n}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Aprobar el plan antes de empezar" hint="Puedes cambiar el reparto o quitar tareas antes de que trabajen">
                <Switch checked={settings.orchApprovePlan} onChange={(v) => set({ orchApprovePlan: v })} />
              </Row>
              <Row label="Tareas en paralelo" hint="Con 2, Claude y Codex trabajan a la vez en sus worktrees">
                <div className="seg">
                  {[1, 2].map((n) => (
                    <button key={n} className={settings.orchParallel === n ? 'on' : ''} onClick={() => set({ orchParallel: n })}>
                      {n}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Carpeta de worktrees" hint="Donde se crean las ramas de trabajo de los agentes">
                <input
                  className="input mono"
                  placeholder="~/.ambidex/worktrees"
                  defaultValue={settings.worktreeDir ?? ''}
                  onBlur={(e) => e.target.value !== (settings.worktreeDir ?? '') && set({ worktreeDir: e.target.value.trim() })}
                />
              </Row>
            </>
          )}
          {section === 'permissions' && (
            <>
              <h2>Permisos</h2>
              <p className="muted">Valores por defecto para las conversaciones nuevas. Cada conversación puede cambiarlos desde su cuadro de texto.</p>
              <Row
                label="Los agentes pueden usar la Web del proyecto"
                hint="Abrir direcciones, leer la página, pulsar, escribir y hacer capturas en tu pestaña Web (con tus cookies de esa pestaña). Lo ves en directo y puedes quitarles el control. Nunca ejecutan JavaScript propio."
              >
                <Switch checked={settings.agentWeb !== false} onChange={(v) => set({ agentWeb: v })} />
              </Row>
              <Row label="Claude Code" hint="Modo de permisos (--permission-mode)">
                <select className="select" value={settings.claudeMode} onChange={(e) => set({ claudeMode: e.target.value as ClaudeMode })}>
                  <option value="plan">Plan (solo lectura)</option>
                  <option value="acceptEdits">Editar ficheros</option>
                  <option value="auto">Auto</option>
                  <option value="dontAsk">No preguntar (denegar)</option>
                  <option value="manual">Manual (según tu configuración)</option>
                  <option value="bypassPermissions">Sin límites</option>
                </select>
              </Row>
              <Row label="Codex" hint="Sandbox (sandbox_mode)">
                <select className="select" value={settings.codexSandbox} onChange={(e) => set({ codexSandbox: e.target.value as CodexSandbox })}>
                  <option value="read-only">Solo lectura</option>
                  <option value="workspace-write">Escritura en el workspace</option>
                  <option value="danger-full-access">Acceso total</option>
                </select>
              </Row>
              <Row
                label="Compactar las conversaciones"
                hint="Al pasar de este contexto, el agente resume lo hablado y sigue. El tope es el mismo para Claude y Codex: en Ambos los dos guardan la misma memoria y cualquiera puede seguir la conversación. Cada paso relee todo el contexto, así que un tope evita gastar de más; 200k deja memoria de sobra para tareas largas."
              >
                <label className="pill" title="Tope de contexto para Claude y Codex">
                  <AgentLogo agent="claude" size={12} />
                  <AgentLogo agent="codex" size={12} />
                  <select value={String(settings.autoCompact ?? 200000)} onChange={(e) => set({ autoCompact: Number(e.target.value) })}>
                    <option value="120000">120k · más ahorro</option>
                    <option value="160000">160k</option>
                    <option value="200000">200k · recomendado</option>
                    <option value="300000">300k · más memoria</option>
                    <option value="0">Sin tope (lo de cada CLI)</option>
                  </select>
                </label>
              </Row>
              <Row label="Codex: acceso a red en el sandbox" hint="Permite a Codex instalar dependencias o llamar a servicios mientras edita (sandbox_workspace_write.network_access)">
                <Switch checked={settings.codexNetwork} onChange={(v) => set({ codexNetwork: v })} />
              </Row>
              <Row label="Codex: búsqueda web">
                <div className="seg">
                  {(
                    [
                      ['default', 'Por defecto'],
                      ['live', 'En vivo'],
                      ['disabled', 'Desactivada']
                    ] as const
                  ).map(([v, l]) => (
                    <button key={v} className={settings.codexWebSearch === v ? 'on' : ''} onClick={() => set({ codexWebSearch: v })}>
                      {l}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Usar siempre tu suscripción" hint="Ignora ANTHROPIC_API_KEY y OPENAI_API_KEY del entorno al lanzar los agentes, para que nunca se facture por API.">
                <Switch checked={settings.stripApiKeys} onChange={(v) => set({ stripApiKeys: v })} />
              </Row>
            </>
          )}
          {section === 'extensions' && (
            <>
              <h2>Extensiones</h2>
              <p className="muted">Plugins, skills, subagentes, comandos, servidores MCP, hooks e instrucciones que usa cada agente: los tuyos y los del proyecto abierto.</p>
              <ExtensionsSection />
            </>
          )}
          {section === 'prompts' && (
            <>
              <h2>Prompts</h2>
              <p className="muted">
                Escribe <b>/</b> al principio de un mensaje para elegir uno: su texto sustituye a <b>/nombre</b> y puedes completarlo antes de enviarlo.
              </p>
              <PromptsSection />
            </>
          )}
          {section === 'general' && (
            <>
              <h2>General</h2>
              <Row label="Agente por defecto" hint="Para ⌘N cuando ves los dos agentes">
                <div className="seg">
                  {(['claude', 'codex'] as AgentId[]).map((a) => (
                    <button key={a} className={settings.defaultAgent === a ? 'on' : ''} onClick={() => set({ defaultAgent: a })}>
                      <AgentLogo agent={a} size={12} /> {AGENT_NAMES[a]}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Mensajes de commit" hint="Agente que genera el mensaje con el botón ✦ Generar">
                <div className="seg">
                  {(['claude', 'codex'] as AgentId[]).map((a) => (
                    <button key={a} className={settings.commitAgent === a ? 'on' : ''} onClick={() => set({ commitAgent: a })}>
                      {AGENT_NAMES[a]}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Notificaciones" hint="Aviso de macOS cuando un agente termina y no estás mirando ese proyecto">
                <Switch checked={settings.notifications} onChange={(v) => set({ notifications: v })} />
              </Row>
            </>
          )}
          {section === 'appearance' && (
            <>
              <h2>Apariencia</h2>
              <Row label="Tema">
                <div className="seg">
                  {(
                    [
                      ['dark', 'Oscuro', 'moon'],
                      ['light', 'Claro', 'sun'],
                      ['system', 'Sistema', 'monitor']
                    ] as [Theme, string, IconName][]
                  ).map(([t, label, icon]) => {
                    const I = Icon[icon]
                    return (
                      <button key={t} className={settings.theme === t ? 'on' : ''} onClick={() => set({ theme: t })}>
                        <I size={12} /> {label}
                      </button>
                    )
                  })}
                </div>
              </Row>
            </>
          )}
          {section === 'shortcuts' && (
            <>
              <h2>Atajos de teclado</h2>
              <Shortcuts />
            </>
          )}
          {section === 'data' && (
            <>
              <h2>Datos locales</h2>
              <DataSection />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function TextDialog() {
  const dialog = useApp((s) => s.dialog)
  const [v, setV] = useState('')
  useEffect(() => setV(dialog?.value ?? ''), [dialog])
  if (!dialog) return null
  return (
    <div className="overlay center" onMouseDown={() => dialog.resolve(null)}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{dialog.title}</h3>
        <input
          autoFocus
          className="input"
          placeholder={dialog.placeholder}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && v.trim()) dialog.resolve(v.trim())
            if (e.key === 'Escape') dialog.resolve(null)
          }}
        />
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => dialog.resolve(null)}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!v.trim()} onClick={() => dialog.resolve(v.trim())}>
            Aceptar
          </button>
        </div>
      </div>
    </div>
  )
}
