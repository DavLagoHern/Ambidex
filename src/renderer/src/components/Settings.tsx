import { ReactNode, useEffect, useState } from 'react'
import type { AgentId, AgentInfo, AppInfo, ClaudeMode, CodexSandbox, JevTest, RouteCategory, SavedPrompt, Settings as S, Theme } from '@shared/types'
import { AGENT_NAMES, DEFAULT_PROMPTS, DEFAULT_ROUTE_PREFS } from '@shared/types'
import { ORCH_MODES, OrchMode } from '@shared/orchestrator'
import { CATEGORY_LABELS } from '@shared/router'
import { api } from '../lib/api'
import { confirmAsync, refreshAgents, saveSettings, setApp, toast, useApp } from '../lib/app-store'
import { COMMANDS } from '../lib/commands'
import { timeAgo, uid } from '../lib/utils'
import { ExtensionsSection } from './Extensions'
import { AgentLogo, Icon, IconName } from './Icons'

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: 'agents', label: 'Agentes y cuentas', icon: 'bot' },
  { id: 'extensions', label: 'Extensiones', icon: 'layers' },
  { id: 'router', label: 'Motor de enrutado', icon: 'zap' },
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
              <b>{test.category ? CATEGORY_LABELS[test.category] : 'Sin un tipo claro'}</b>
              {test.confidence !== undefined && <span className="muted"> · confianza {Math.round(test.confidence * 100)}%</span>}
              <span className="muted"> · {test.ms} ms</span>
              <div className="muted">{top.map(([c, v]) => `${CATEGORY_LABELS[c]} ${Math.round(v * 100)}%`).join(' · ')}</div>
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
      <Row label="Modelo por defecto">
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
          Ambidex {info?.version} · Electron {info?.electron} · Node {info?.node}
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
              <div className="set-sub">Quién atiende cada tipo de tarea (tus preferencias)</div>
              {(Object.keys(CATEGORY_LABELS) as RouteCategory[]).map((c) => {
                const prefs = { ...DEFAULT_ROUTE_PREFS, ...(settings.routePrefs ?? {}) }
                return (
                  <Row key={c} label={CATEGORY_LABELS[c]}>
                    <div className="seg">
                      {(['claude', 'any', 'codex'] as const).map((a) => (
                        <button key={a} className={prefs[c] === a ? 'on' : ''} onClick={() => set({ routePrefs: { ...prefs, [c]: a } })}>
                          {a === 'any' ? 'El más libre' : AGENT_NAMES[a]}
                        </button>
                      ))}
                    </div>
                  </Row>
                )
              })}
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
                  {settings.allowUnrestricted && <option value="bypassPermissions">Sin límites</option>}
                </select>
              </Row>
              <Row label="Codex" hint="Sandbox (sandbox_mode)">
                <select className="select" value={settings.codexSandbox} onChange={(e) => set({ codexSandbox: e.target.value as CodexSandbox })}>
                  <option value="read-only">Solo lectura</option>
                  <option value="workspace-write">Escritura en el workspace</option>
                  {settings.allowUnrestricted && <option value="danger-full-access">Acceso total</option>}
                </select>
              </Row>
              <Row label="Permitir modos sin restricciones" hint="Habilita «Sin límites» (Claude) y «Acceso total» (Codex). Desaconsejado fuera de entornos aislados.">
                <Switch
                  checked={settings.allowUnrestricted}
                  onChange={(v) =>
                    set({
                      allowUnrestricted: v,
                      ...(!v && settings.claudeMode === 'bypassPermissions' ? { claudeMode: 'acceptEdits' as const } : {}),
                      ...(!v && settings.codexSandbox === 'danger-full-access' ? { codexSandbox: 'workspace-write' as const } : {})
                    })
                  }
                />
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
