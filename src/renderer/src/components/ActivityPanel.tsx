import { ReactNode, useEffect, useState } from "react";
import type { AgentId, RunInfo } from "@shared/types";
import { AGENT_NAMES, AGENTS } from "@shared/types";
import { setApp, useApp } from "../lib/app-store";
import { ActivityEntry, SessionView, usePS, useStore } from "../lib/project-store";
import { durationText, timeAgo } from "../lib/utils";
import { AgentLogo, Icon } from "./Icons";

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const STATUS: Record<RunInfo["status"], { label: string; cls: string }> = {
  running: { label: "Trabajando", cls: "running" },
  completed: { label: "Terminó", cls: "ok" },
  failed: { label: "Falló", cls: "error" },
  cancelled: { label: "Detenido", cls: "muted" },
  interrupted: { label: "Interrumpido", cls: "warn" },
};

function ProcessCard({ session, run }: { session: SessionView; run?: RunInfo }) {
  const ps = usePS();
  const queue = useStore((s) => s.queue);
  const threads = useStore((s) => s.threads);
  const orchs = useStore((s) => s.orchs);
  const running = session.running;
  const now = useNow(running);
  const threadId = session.threadId ?? (session.orchestrationId ? orchs[session.orchestrationId]?.threadId : undefined);
  const waiting = queue.filter((q) => q.sessionId === session.id || (threadId && q.threadId === threadId)).length;
  const st = running ? STATUS.running : run ? STATUS[run.status] : null;
  const title = (threadId && threads[threadId]?.title) || session.title || run?.sessionTitle || "Conversación";
  return (
    <button className={`act-process ${running ? "running" : ""} ${st?.cls ?? ""}`} onClick={() => ps.focusSession(session.id)} title={`${title} · ${running ? "Procesando" : st?.label ?? ""}`}>
      {running ? <span className={`pulse small agent-${session.agent}`} /> : <span className={`act-dot ${st?.cls ?? "muted"}`} />}
      <span className="act-process-title ellipsis">{threadId || session.orchestrationId ? <span className="act-where">Ambos · </span> : null}{title}</span>
      {waiting > 0 && <span className="act-process-queue" title={`${waiting} en cola`}>{waiting}</span>}
      {run && <span className="act-process-time">{running ? durationText(now - run.startedAt) : timeAgo((run.endedAt ?? run.startedAt) / 1000)}</span>}
    </button>
  );
}

// Las tarjetas finalizadas pasan al grupo al minuto. El grupo conserva como máximo
// diez conversaciones de las últimas 24 horas; el historial completo sigue en Actividad.
const GROUP_AFTER = 60_000;
const KEEP_FINISHED = 24 * 3600_000;
const MAX_FINISHED = 10;

function AgentCard({ agent }: { agent: AgentId }) {
  const ps = usePS();
  const now = useNow(true);
  const storageKey = `ambidex.finished-cleared.${ps.id}.${agent}`;
  const [clearedAt, setClearedAt] = useState(() => {
    try { return Number(localStorage.getItem(storageKey)) || 0; } catch { return 0; }
  });
  const clearFinished = () => {
    const at = Date.now() - GROUP_AFTER;
    setClearedAt(at);
    try { localStorage.setItem(storageKey, String(at)); } catch { /* sin almacenamiento */ }
  };
  const sessions = useStore((s) => s.sessions);
  const runs = useStore((s) => s.runs);
  const info = useApp((s) => s.agentInfo.find((a) => a.agent === agent));
  const latest = new Map<string, RunInfo>();
  for (const run of runs) if (run.agent === agent && !latest.has(run.sessionId)) latest.set(run.sessionId, run);
  const processes = Object.values(sessions)
    .filter((s) => s.agent === agent && (s.running || latest.has(s.id)))
    .sort((a, b) => Number(b.running) - Number(a.running) || (latest.get(b.id)?.startedAt ?? b.updatedAt) - (latest.get(a.id)?.startedAt ?? a.updatedAt));
  const active = processes.filter((s) => s.running).length;
  const endedAt = (s: SessionView) => {
    const run = latest.get(s.id);
    return run?.endedAt ?? run?.startedAt ?? 0;
  };
  const visible = processes.filter((s) => s.running || now - endedAt(s) < GROUP_AFTER);
  const finished = processes.filter((s) => !s.running && now - endedAt(s) >= GROUP_AFTER && now - endedAt(s) < KEEP_FINISHED && endedAt(s) > clearedAt)
    .sort((a, b) => endedAt(b) - endedAt(a)).slice(0, MAX_FINISHED);
  const offline = info && (!info.path || info.auth?.loggedIn === false);
  return (
    <div className={`act-card agent-${agent} ${active ? "running" : ""}`}>
      <div className="act-card-head">
        <AgentLogo agent={agent} size={16} /><b>{AGENT_NAMES[agent]}</b><span style={{ flex: 1 }} />
        {offline ? <button className="status-chip warn" onClick={() => setApp({ loginAgent: agent })}>Sin sesión</button> : active ? <span className="status-chip running"><span className={`pulse small agent-${agent}`} />{active} procesando</span> : <span className="status-chip muted">En espera</span>}
      </div>
      {visible.length > 0 && <div className="act-processes">{visible.map((s) => <ProcessCard key={s.id} session={s} run={latest.get(s.id)} />)}</div>}
      {finished.length > 0 && <details className="act-finished">
        <summary>
          Terminados <span className="count">{finished.length}</span><span style={{ flex: 1 }} />
          <button className="act-clear" onClick={(e) => { e.preventDefault(); clearFinished(); }} title="Quitar los terminados de aquí (siguen en Actividad)">Limpiar</button>
        </summary>
        <div className="act-processes">{finished.map((s) => <ProcessCard key={s.id} session={s} run={latest.get(s.id)} />)}</div>
      </details>}
    </div>
  );
}

function Timeline({ entries }: { entries: ActivityEntry[] }) {
  const ps = usePS();
  if (!entries.length)
    return (
      <div className="empty small">
        La actividad de los agentes aparecerá aquí en cuanto empiecen a
        trabajar.
      </div>
    );
  return (
    <div className="timeline">
      {entries.slice(0, 80).map((e) => (
        <button
          key={e.id}
          className={`tl-row tl-${e.kind} st-${e.status ?? ""}`}
          onClick={() => ps.focusSession(e.sessionId)}
          title={e.detail}
        >
          <span className={`tl-dot agent-${e.agent}`} />
          <span className="tl-time tabular">
            {new Date(e.at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span className="tl-text ellipsis">
            <b>{e.text}</b>{" "}
            {e.detail && <span className="muted mono">{e.detail}</span>}
          </span>
          {e.status === "running" ? (
            <Icon.spinner size={11} className="spin muted" />
          ) : e.status === "error" ? (
            <Icon.fail size={11} className="del" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

// Botón de cerrar de la cabecera: oculta el panel (o devuelve la ventana suelta a la principal)
function CloseButton({ panel }: { panel: "agents" | "activity" }) {
  const ps = usePS();
  return (
    <span className="row-actions always">
      <button
        className="icon-btn"
        title={
          ps.secondary
            ? "Devolver a la ventana principal"
            : "Ocultar el panel · vuelve desde la barra de arriba"
        }
        onClick={() =>
          ps.secondary ? window.close() : ps.toggleDock(panel, false)
        }
      >
        <Icon.x size={14} />
      </button>
    </span>
  );
}

// Título que pliega el panel: plegado, solo queda la cabecera (y en una columna, su sitio pasa al de al lado)
function FoldTitle({
  panel,
  label,
  extra,
}: {
  panel: "agents" | "activity";
  label: string;
  extra?: ReactNode;
}) {
  const ps = usePS();
  const folded = useStore((s) => s.folded.includes(panel));
  return (
    <button
      className={`section-toggle ${folded ? "folded" : ""}`}
      onClick={() => ps.toggleFold(panel)}
      title={
        folded
          ? `Desplegar ${label.toLowerCase()}`
          : `Plegar ${label.toLowerCase()}`
      }
    >
      <Icon.chevronDown size={12} className="section-chevron" />
      {panel === "agents" ? <Icon.bot size={12} className="section-icon" /> : <Icon.activity size={12} className="section-icon" />}
      <span>{label}</span>
      {folded && extra}
    </button>
  );
}

// Panel «Agentes»: una tarjeta por agente con lo que está haciendo
export function AgentsPanel() {
  const enabled = useApp((s) => s.settings?.enabledAgents);
  const folded = useStore((s) => s.folded.includes("agents"));
  const busy = useStore(
    (s) => Object.values(s.sessions).filter((x) => x.running).length,
  );
  return (
    <div className="panel right-panel">
      <div className="panel-header">
        <FoldTitle
          panel="agents"
          label="Agentes"
          extra={
            busy > 0 ? (
              <span className="pulse small" title={`${busy} trabajando`} />
            ) : undefined
          }
        />
        <CloseButton panel="agents" />
      </div>
      {!folded && (
        <div className="act-cards">
          {AGENTS.filter((a) => !enabled || enabled.includes(a)).map((a) => (
            <AgentCard key={a} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}

// Panel «Actividad»: lo que han hecho los agentes y sus ejecuciones. Se coloca, se arrastra y se saca a otra ventana
// igual que el de Agentes.
export function ActivityLogPanel() {
  const ps = usePS();
  const activity = useStore((s) => s.activity);
  const runs = useStore((s) => s.runs);
  const [tab, setTab] = useState<"activity" | "runs">("activity");
  const folded = useStore((s) => s.folded.includes("activity"));

  return (
    <div className="panel right-panel">
      <div className="panel-header">
        <FoldTitle
          panel="activity"
          label="Actividad"
          extra={
            runs.length > 0 ? (
              <span className="count">{runs.length}</span>
            ) : undefined
          }
        />
        <CloseButton panel="activity" />
      </div>
      {!folded && (
        <>
          <div className="panel-tools">
            <div className="seg">
              <button
                className={tab === "activity" ? "on" : ""}
                onClick={() => setTab("activity")}
              >
                Actividad
              </button>
              <button
                className={tab === "runs" ? "on" : ""}
                onClick={() => setTab("runs")}
              >
                Ejecuciones{" "}
                {runs.length > 0 && (
                  <span className="count">{runs.length}</span>
                )}
              </button>
            </div>
          </div>
          <div className="panel-body">
            {tab === "activity" ? (
              <Timeline entries={activity} />
            ) : runs.length ? (
              runs.map((r) => (
                <div
                  key={r.id}
                  className="run-row"
                  onClick={() => ps.focusSession(r.sessionId)}
                >
                  <AgentLogo agent={r.agent} size={13} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ellipsis">
                      {r.sessionTitle ?? "Conversación"}
                    </div>
                    <div className="muted tiny">
                      {timeAgo(r.startedAt / 1000)}
                      {r.endedAt
                        ? ` · ${durationText(r.endedAt - r.startedAt)}`
                        : ""}
                      {r.error
                        ? ` · ${r.error.split("\n")[0].slice(0, 60)}`
                        : ""}
                    </div>
                  </div>
                  <span className={`status-chip ${STATUS[r.status].cls}`}>
                    {STATUS[r.status].label}
                  </span>
                  <button
                    className="icon-btn"
                    title="Ver registro técnico"
                    onClick={(e) => {
                      e.stopPropagation();
                      ps.set((s) => ({
                        bottomTab: "log",
                        logRun: r.id,
                        panels: { ...s.panels, bottom: true },
                      }));
                    }}
                  >
                    <Icon.log size={12} />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty small">Sin ejecuciones todavía.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
