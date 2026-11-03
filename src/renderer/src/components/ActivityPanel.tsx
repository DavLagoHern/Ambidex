import { ReactNode, useEffect, useState } from "react";
import type { AgentId, ChatItem, RunInfo } from "@shared/types";
import { AGENT_NAMES, AGENTS } from "@shared/types";
import { setApp, useApp } from "../lib/app-store";
import { ActivityEntry, usePS, useStore } from "../lib/project-store";
import { basename, durationText, timeAgo } from "../lib/utils";
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

function AgentCard({ agent }: { agent: AgentId }) {
  const ps = usePS();
  const run = useStore((s) => s.runs.find((r) => r.agent === agent));
  const session = useStore((s) =>
    run ? s.sessions[run.sessionId] : s.sessions[s.active[agent] ?? ""],
  );
  const last = useStore((s) =>
    s.activity.find(
      (a) =>
        a.agent === agent &&
        (a.kind === "tool" || a.kind === "files" || a.kind === "error"),
    ),
  );
  const info = useApp((s) => s.agentInfo.find((a) => a.agent === agent));
  // otras conversaciones de este agente que están trabajando a la vez (la tarjeta enseña la principal)
  const otherKey = useStore((s) =>
    Object.values(s.sessions)
      .filter(
        (x) =>
          x.agent === agent &&
          x.running &&
          x.id !== (run ? run.sessionId : s.active[agent]),
      )
      .map((x) => x.id)
      .join(","),
  );
  const others = useStore((s) => s.sessions);
  const running = run?.status === "running";
  const now = useNow(running);

  // ficheros tocados en el turno actual (o el último)
  const files: string[] = [];
  const items: ChatItem[] = session?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "user") break;
    if (it.type === "files") files.push(...it.files.map((f) => f.path));
  }

  const st = run ? STATUS[run.status] : null;
  const offline = info && (!info.path || info.auth?.loggedIn === false);

  return (
    <div className={`act-card agent-${agent} ${running ? "running" : ""}`}>
      <div className="act-card-head">
        <AgentLogo agent={agent} size={16} />
        <b>{AGENT_NAMES[agent]}</b>
        <span style={{ flex: 1 }} />
        {offline ? (
          <button
            className="status-chip warn"
            onClick={() => setApp({ loginAgent: agent })}
          >
            Sin sesión
          </button>
        ) : st ? (
          <span className={`status-chip ${st.cls}`}>
            {running && <span className={`pulse small agent-${agent}`} />}{" "}
            {st.label}
          </span>
        ) : (
          <span className="status-chip muted">En espera</span>
        )}
      </div>
      {session ? (
        <button
          className="act-session ellipsis"
          onClick={() => ps.focusSession(session.id)}
          title={
            session.threadId || session.orchestrationId
              ? "Ir a la conversación (en Ambos)"
              : "Ir a la conversación"
          }
        >
          {(session.threadId || session.orchestrationId) && (
            <span className="act-where">Ambos · </span>
          )}
          {session.title}
        </button>
      ) : (
        <div className="muted small">Sin conversaciones todavía</div>
      )}
      {otherKey && (
        <div className="act-others">
          {otherKey.split(",").map((id) => (
            <button
              key={id}
              className="act-other ellipsis"
              onClick={() => ps.focusSession(id)}
              title="Ir a esta conversación"
            >
              <span className={`pulse small agent-${agent}`} />
              {(others[id]?.threadId || others[id]?.orchestrationId) && (
                <span className="act-where">Ambos · </span>
              )}
              {others[id]?.title ?? "Conversación"}
            </button>
          ))}
        </div>
      )}
      {run && (
        <div className="act-meta small muted">
          <Icon.clock size={11} />{" "}
          {running
            ? durationText(now - run.startedAt)
            : `${durationText((run.endedAt ?? run.startedAt) - run.startedAt)} · ${timeAgo((run.endedAt ?? run.startedAt) / 1000)}`}
          {files.length > 0 && (
            <>
              {" "}
              · <Icon.fileEdit size={11} /> {files.length}
            </>
          )}
        </div>
      )}
      {running && last && (
        <div className="act-now mono small ellipsis" title={last.detail}>
          {last.status === "running" ? (
            <Icon.spinner size={11} className="spin" />
          ) : (
            <Icon.check size={11} />
          )}{" "}
          {last.text} {last.detail}
        </div>
      )}
      {files.length > 0 && (
        <div className="act-files">
          {files.slice(0, 5).map((f) => (
            <button
              key={f}
              className="act-file ellipsis"
              onClick={() =>
                ps.openDiff(
                  ps.repoFor(f),
                  f.slice(ps.repoFor(f).length + 1),
                  "head",
                )
              }
            >
              {basename(f)}
            </button>
          ))}
          {files.length > 5 && (
            <span className="muted small">+{files.length - 5}</span>
          )}
        </div>
      )}
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
      <span>{label}</span>
      {folded && extra}
    </button>
  );
}

// Panel «Agentes»: una tarjeta por agente con lo que está haciendo
export function AgentsPanel() {
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
          {AGENTS.map((a) => (
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
