# Arquitectura de Ambidex

Aplicación de escritorio macOS para desarrollar con **Claude Code** y **OpenAI Codex** a la vez,
usando los CLI oficiales instalados y las cuentas en las que el usuario ya ha iniciado sesión
(claude.ai / ChatGPT). No usa APIs ni claves.

## 1. Entorno verificado (nov 2026)

| Herramienta | Versión | Notas |
|---|---|---|
| macOS | 27.0.1 (arm64) | Solo Command Line Tools, **sin Xcode** |
| Claude Code | 2.1.316 | `claude auth status --json` → `loggedIn`, `authMethod: claude.ai`, `subscriptionType` |
| Codex CLI | 0.155.1 | `codex login status` → "Logged in using ChatGPT" |
| Git / gh | 2.54 / 2.96 | |
| Node | 24.5 | |
| Rust / cargo | — | no instalado |

### Capacidades reales de los CLI (comprobadas ejecutándolos)

| Capacidad | Claude Code | Codex |
|---|---|---|
| Modo no interactivo | `-p` | `exec` |
| Streaming estructurado | `--output-format stream-json --verbose --include-partial-messages` | `--json` (JSONL: `thread.started`, `item.*`, `turn.*`) |
| Reanudar sesión | `--resume <id>`; `--session-id <uuid>` para fijar el id | `exec resume <thread_id>` |
| Salida estructurada | `--json-schema` → `structured_output` en el `result` | `--output-schema <fichero>` |
| Permisos | `--permission-mode plan/acceptEdits/auto/dontAsk/manual/bypassPermissions`, `--allowedTools`, `--disallowedTools` | `-s read-only/workspace-write/danger-full-access` |
| Límites de uso | evento `rate_limit_event` (`unifiedWindows.five_hour/seven_day`) | `rate_limits` en el rollout `~/.codex/sessions/**.jsonl` |
| Modelos | alias (`opus`, `sonnet`, `haiku`, `fable`) o id completo | `codex debug models` (catálogo que el servidor ofrece a la versión instalada) |
| Login oficial | `claude auth login` | `codex login` |

Hallazgos que condicionan el diseño:

- `~/.codex/config.toml` tiene `model = "gpt-6.1-sol"`. El CLI instalado (0.155.1) no puede usarlo: el servidor
  responde `model_not_found`. Además, `~/.codex/models_cache.json` lo comparten otros clientes de Codex (la app
  de escritorio lo reescribió como cliente 0.163.0 y pasó a listar `gpt-6.1-sol`). Por eso la app pide el catálogo
  al propio CLI con `codex debug models`, deja la caché solo como respaldo y elige un modelo válido cuando
  `config.toml` apunta a uno que no está disponible. (Codex 0.166.0, instalado el 2026-11-02, ya ofrece
  `gpt-6.1-sol` y `gpt-6.1-terra`.)
- En modo `-p`, Claude se lanza con `--permission-prompts none`: sin un host que responda, lo que requeriría
  permiso se deniega de forma determinista y aparece en `permission_denials`, que la UI muestra.
- Ambos CLI aceptan el prompt por stdin (`claude -p` sin argumento; `codex exec -`, también al reanudar), lo que
  evita que un prompt que empiece por `-` se interprete como opción.
- Si la app se lanza desde una terminal que ya ejecuta Claude Code, hereda variables de sesión
  (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`…). Se eliminan del entorno de los agentes.
- Si existen `ANTHROPIC_API_KEY` u `OPENAI_API_KEY`, los CLI las usarían en vez de la suscripción. Se eliminan.
- `--bare` fuerza clave API en Claude: no se usa nunca.

## 2. Elección del stack

**Electron 45 + React 18 + TypeScript + Vite**, con `node:sqlite`, `node-pty`, xterm.js y Monaco.

- **SwiftUI** daría la experiencia más nativa, pero sin Xcode no hay empaquetado/firmado cómodo, y el editor
  (Monaco), la terminal (xterm.js) y los diffs tendrían que incrustarse en `WKWebView` de todos modos.
- **Tauri 2** requiere instalar Rust y reescribir la capa nativa (PTY, procesos, Git) en Rust; no aporta nada
  que Electron no dé aquí y añade riesgo.
- **Electron** ya era la base del proyecto, integra Monaco/xterm/node-pty sin fricción y Electron 45 trae
  Node 24 con `node:sqlite`: **persistencia SQLite sin módulos nativos** y testeable con Node normal.

## 3. Módulos

```
src/shared/          contrato común (sin dependencias de Electron)
  types.ts           dominio: Project, Session, ChatItem, AgentEvent, Run…
  ipc.ts             contrato IPC tipado: canal → (args) => resultado
  chat.ts            reductor puro AgentEvent → ChatItem[] (lo usa el proceso principal)
  router.ts          motor de enrutado (reglas o clasificación de Jev + preferencias)
  web.ts             visor web: normalizar direcciones, detectar enlaces en texto

src/main/            proceso principal (único que toca disco, procesos y Git)
  index.ts           ciclo de vida, ventana, menú macOS, notificaciones
  ipc.ts             registro de handlers del contrato + validación
  db/                SQLite: apertura, migraciones versionadas, consultas tipadas
  agents/
    env.ts           PATH del login shell, localización de binarios, entorno saneado
    claude.ts        adaptador Claude: args + parser de stream-json
    codex.ts         adaptador Codex: args + parser de JSONL + modelos/límites
    runner.ts        procesos hijos: grupo de procesos propio, cancelación real (SIGTERM→SIGKILL)
    service.ts       SessionService: envío → ejecución → reductor → persistencia → eventos a la UI
    auth.ts          estado de autenticación y login oficial
  web.ts             visor web: <webview> aislado, menús contextuales, ventanas flotantes, favicons
  jev.ts             Jev: instalación verificada, servidor local bajo demanda, clasificación
  mcp-server.ts      servidor MCP mínimo (HTTP en 127.0.0.1, una clave por turno) para herramientas propias
  web-agent.ts       herramientas MCP de la Web: abrir, leer con elementos numerados, pulsar, escribir, capturar
  checkpoints.ts     fotos de los ficheros antes y después de cada turno (trees de Git) y deshacer
  attachments.ts     imágenes adjuntas: carpeta propia y rutas comprobadas
  external-sessions.ts  conversaciones de Claude Code y Codex empezadas fuera de la app
  extensions.ts      plugins, skills, subagentes, comandos, MCP, hooks e instrucciones de cada CLI (toml-lite.ts)
  devserver.ts       scripts de desarrollo de package.json
  git.ts files.ts terminal.ts security.ts logger.ts

src/preload/         puente mínimo (invoke/on + ruta de ficheros soltados)
src/renderer/        UI React
  lib/app-store.ts   estado global: proyectos, pestañas, ajustes, agentes
  lib/project-store.ts  un ProjectStore por proyecto abierto (aislado)
  lib/highlight.ts   resaltado ligero de los bloques de código del chat (sin Monaco)
  lib/dock.ts        disposición de los paneles: árbol, reparto de tamaños, dónde cae un panel arrastrado y diseños de serie
  components/        TabBar, Dock, Sidebar, Chat, Editor, Git, Terminal, Activity, Palette, Settings, WebPanel…
  WebWindow.tsx      raíz de las ventanas web flotantes (#web=<url>)
  PanelWindow.tsx    un panel (chat, terminal, editor, agentes) en su propia ventana (#panel=…&project=…)
```

### Principios

- **El proceso principal es la fuente de verdad** de conversaciones y ejecuciones. Cada evento de un agente
  se reduce a `ChatItem`s y se guarda en SQLite *antes* de enviarse a la UI. Si la UI se recarga o la app se
  cierra de golpe, el historial ya está en disco.
- **Adaptadores independientes por CLI** con funciones puras (`buildArgs`, `createParser`) probadas con
  salidas reales capturadas; el runner es común.
- **Cada proyecto tiene su propio store** en el renderer. Los proyectos visitados permanecen montados
  (ocultos), así que al volver a una pestaña el chat, el scroll, los editores Monaco y las terminales siguen
  exactamente igual. La disposición de los paneles se guarda por proyecto en SQLite.
- **Herramientas propias para los agentes por MCP:** la app arranca un servidor MCP en `127.0.0.1` (transporte HTTP, respuestas JSON).
  - Cada turno recibe una clave en `CODEAI_WEB_TOKEN` y el servidor por `--mcp-config` (Claude, con `--allowedTools mcp__codeai_web`) o `-c mcp_servers.codeai_web.*` (Codex, con `default_tools_approval_mode="approve"`).
  - La clave caduca al terminar el turno o si el usuario quita el control.
  - Los clics y las teclas llegan a la página como eventos reales (`sendInputEvent`) en coordenadas del elemento.
- **Deshacer un turno sin tocar Git:** antes y después de cada ejecución se escribe un *tree* con `git add -A` sobre una copia del índice (con su fecha original, para que Git relea los ficheros tocados en el mismo segundo).
  - Deshacer restaura, desde el tree de antes, cada fichero que cambió entre las dos fotos, salvo los que han cambiado desde la de después.
- **Ventanas de panel:** los avisos del proceso principal llegan a todas las ventanas.
  - Una ventana de panel crea su propio `ProjectStore` en modo secundario: no guarda estado ni vigila ficheros, y sus enlaces se abren en la Web de la principal.
  - Las terminales se enganchan (`term:create` devuelve lo último que mostraron) y solo la ventana principal puede cerrarlas.
  - La lista de terminales se sincroniza entre ventanas.
- **Paneles movibles sin volver a montarlos** (`lib/dock.ts`, `components/Dock.tsx`):
  - La disposición es un árbol de filas y columnas cuyas hojas son los seis paneles. Cada nodo guarda su tamaño en píxeles.
  - En cada división, el hijo con el panel principal visible (el chat, o el editor en la disposición «código») se queda el espacio libre, así que al cambiar el tamaño de la ventana los laterales no se deforman y se respetan los mínimos.
  - Los paneles se pintan como hermanos con posición absoluta en los rectángulos calculados. Moverlos solo cambia su `style`, nunca su padre en el DOM, por eso las terminales (que se cierran al desmontarse) y los `<webview>` (que se recargan al moverlos en el DOM) siguen intactos.
  - Ocultar un panel no lo saca del árbol: vuelve a aparecer en su sitio.
- **Nada de shell**: todos los procesos se lanzan con `spawn/execFile` y arrays de argumentos.
- **Carga bajo demanda**: Monaco (6,2 MB) y xterm (0,4 MB) son trozos aparte que solo se cargan al abrir un
  fichero/diff o una terminal; el chat resalta su código con `lib/highlight.ts`. El JavaScript de arranque
  pasa de 7,2 MB a ≈0,5 MB.

## 4. Modelo de datos (SQLite, `~/Library/Application Support/Ambidex/ambidex.db`)

```
settings       key PK, value (JSON)
projects       id PK, path UNIQUE, name, color, git_root, created_at, last_opened_at,
               is_open, tab_order, pinned, ui_state (JSON: layout, paneles, editores, scroll, terminales)
sessions       id PK, project_id FK→projects (CASCADE), agent, title, cwd, agent_session_id,
               model, effort, permission, worktree_path, worktree_branch, totals (JSON),
               created_at, updated_at, archived
messages       id PK, session_id FK→sessions (CASCADE), seq, run_id, type, data (JSON ChatItem),
               search_text, created_at, updated_at        UNIQUE(session_id, seq)
runs           id PK, session_id FK, project_id, agent, status(running|completed|failed|cancelled|interrupted),
               pid, bin, cwd, args (JSON, prompt resumido), started_at, ended_at, exit_code, signal, error, stderr_tail
run_log        id PK, run_id FK, at, stream(stderr|event|system), line       — logs técnicos por ejecución
audit_log      id PK, at, project_id, actor(user|claude|codex|system), action, detail (JSON)
agent_limits   agent PK, data (JSON), updated_at
```

Migración 2 (chat único, cola y orquestador):

```
sessions       + thread_id, orchestration_id
threads        id, project_id, title, created_at, updated_at            — chat único con los dos agentes
queue          id, project_id, session_id | thread_id, prompt, context, agent, position
orchestrations id, project_id, thread_id, mode(A..E), request, status, resume_status, planner, plan (JSON),
               options (JSON), repo, base_branch, base_commit, slug, error, test_result (JSON), integrated_into
orch_tasks     id, orchestration_id, seq, key, title, description, acceptance, assignee, depends_on (JSON),
               status, round, session_id, review_session_id, result (JSON), review (JSON), error, started_at, ended_at
orch_messages  id, orchestration_id, at, from_agent, to_agent, kind, text   — coordinación entre agentes
worktrees      id, project_id, orchestration_id, owner(claude|codex|integration), path, branch, base_commit, status
```

Al arrancar, toda ejecución en estado `running` pasa a `interrupted`, se añade un aviso en su conversación
y, si el PID sigue vivo y corresponde al CLI, se termina (su salida ya no se puede capturar).

## 5. Pantallas

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  [● Web  ⟳ 3] [● API] [● iOS] [+]        ▤ ⌨ 🌐 ∿ ⊞   ⌘K   ⚙      │  pestañas · paneles
├──┬──────────────┬────────────────────────────────────┬───────────────────────┤
│▣ │ Conversaciones│  Chat (Claude | Codex | Ambos)     │ Actividad             │
│▤ │ Explorador    │  ── o editor/diff a la derecha ──  │  Claude ● ejecutando  │
│⎇ │ Git           │                                    │  Codex  ○ en espera   │
│◷ │ Historial     ├────────────────────────────────────┤  Ejecuciones recientes│
│⌕ │ Buscar        │ Terminal 1 | Terminal 2 | Registro │  Ficheros tocados     │
├──┴──────────────┴────────────────────────────────────┴───────────────────────┤
│ ⎇ main · 3 cambios      Claude 5h ▮▮▯ 25%  ·  Codex 5h ▮▯▯ 12%               │  barra de estado
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Barra de pestañas**: color e iniciales del proyecto, spinner si hay agentes trabajando, contador de cambios
  Git, cerrar, menú contextual nativo (fijar, cerrar otras, mostrar en Finder, quitar), reordenar arrastrando,
  soltar carpetas desde Finder para abrirlas.
- **Paneles**: la figura es la disposición de siempre. Cada panel se arrastra por su cabecera a otro sitio, y en la barra de título hay un interruptor por panel y el menú Diseño.
- **Paleta de comandos (⌘K)**: acciones, proyectos y conversaciones. **⌘P**: ficheros.
- **Explorador de proyectos (⌘O)**: todos los proyectos conocidos, abiertos o no.
- **Ajustes**: CLI (ruta, versión, cuenta, login oficial en terminal integrada), modelos, permisos, tema,
  notificaciones, datos locales.

## 6. Chat único y motor de enrutado

`src/shared/router.ts` (puro, testeado) decide quién atiende cada mensaje del modo **Ambos**:
mención explícita → seguimiento de la conversación → preferencias por tipo de tarea (configurables) →
restricciones (agente sin sesión, ≥95 % del límite de uso, ocupado). Quién *entiende* el mensaje es
configurable: palabras clave, **Jev** (modelo local de decisiones) o Claude Haiku.

**Jev** (`src/main/jev.ts`, [feder-cr/jev](https://github.com/feder-cr/jev), MIT): jevos-v5, ≈0,9B parámetros,
OpenVINO INT8 en CPU. Se instala solo si el usuario lo pide desde Ajustes: descarga el binario
`jev-macos-arm64` y el modelo de la release, comprueba ambos contra `SHA256SUMS.txt`, los descomprime en
`~/.ambidex/jev/jevos-v5` y arranca `jev serve` bajo demanda en `127.0.0.1` con un puerto libre y una clave
aleatoria (`JEV_API_KEY`). Cada mensaje es **una** petición a `/v1/systemone` con el mensaje, el agente
anterior y la petición anterior como estado, y dos preguntas: `choice` entre los 8 tipos de tarea y `noul`
"¿continúa la petición anterior?". El tipo (si la confianza ≥ 0,2) pasa por las preferencias del usuario y
las mismas restricciones que las reglas. Si Jev no contesta en 1,2 s (vista previa) o 3 s (envío), deciden
las reglas. Con **modelo según la dificultad** activo (Ajustes → Modelos, `settings.modelPolicy`), la misma
petición lleva una tercera pregunta, `choice` entre `hard` y `easy`; también se pregunta si el agente lo eligió
el usuario o con `@mención`. `pickModel` (en `router.ts`) elige entre los modelos permitidos de ese agente el de
esa dificultad, sin elegir nunca uno que el CLI instalado no ofrezca; el de `hard` solo con dificultad `hard` y seguridad ≥ 0,3 (`HARD_MODEL_CONFIDENCE`); sin estimación o con duda, el de `easy`. El modelo va
solo en ese turno (`SendOptions.model`): las sesiones del hilo no fijan modelo salvo que el usuario elija uno en el
selector (o antes del primer mensaje, en `threads:send` `models`). El razonamiento sigue la misma idea (`pickEffort`, `modelPolicy.autoEffort`): medio por defecto, alto solo si la seguridad de «difícil» es ≥ 0,75 y bajo si la de «sencilla» es ≥ 0,6, nunca por encima de alto salvo que lo fije el usuario (`SendOptions.effort`, `threads:send` `efforts`). Las respuestas se cachean (la vista previa y el envío hacen la misma pregunta). El servidor se
detiene tras 10 minutos sin uso (≈1 GB de memoria) y al salir de la app; si quedó huérfano tras un cierre
inesperado, se detiene al volver a abrir. `Dispatcher` (proceso principal) crea
una sesión por agente dentro de cada hilo y, al cambiar de agente, le pasa lo hablado con el otro. La cola
de mensajes vive en SQLite y se procesa cuando la conversación queda libre.
Si un agente del hilo trabaja, `sendThread` encola sin consultar a Jev; `sendNow(id, 'current' | 'other')` lo añade al
turno en curso o lo lanza en el otro agente, y lo que se deja en la cola lo reparte Jev en `onIdle`.
Claude Code se lanza con `--input-format stream-json` y la entrada abierta: un mensaje enviado mientras trabaja
se escribe en su stdin (`SessionService.steer`) y lo incorpora en el siguiente paso del mismo turno; al llegar el
`result` se cierra la entrada; los mensajes ya escritos se consumen antes de salir.
Codex usa `app-server` para los chats: `initialize` → `thread/start`, `thread/resume` o `thread/fork` → `turn/start`.
`codex-live.ts` traduce las notificaciones al parser compartido y confirma cada inyección con `turn/steer` y
`expectedTurnId`. Los turnos con esquema siguen usando `exec --json`. Los mensajes que llegan al cerrar el turno
se conservan en la cola; enviar nunca cancela el trabajo. En Ambos, si trabajan a la vez, reciben la tarea del
compañero al arrancar y su resumen al finalizar. Es contexto compartido, no exclusión mutua de ficheros.
El renderer muestra el envío de inmediato en una franja de vista previa, fuera del historial, hasta que el motor confirma su destino.

**Actualización de los CLI** (`src/main/agents/updates.ts`): un minuto después de abrir y cada 6 horas, compara
`--version` con los dist-tags de npm (`@anthropic-ai/claude-code` en el canal de `~/.claude/settings.json`,
`@openai/codex`) y, si hay una nueva, la instala según cómo se instaló el binario (ruta real en `Caskroom`/`Cellar`
→ `brew upgrade`, en `lib/node_modules` → `npm install -g`, si no → `<cli> update`; el binario de la extensión de
VS Code no se toca). Nunca con un turno de ese agente en marcha: lo reintenta a los 2 minutos. Después vuelve a
detectar el CLI (versión y catálogo de modelos). No corre con `AMBIDEX_USER_DATA` (E2E).

## 6b. Visor web

Botón **Web** en la barra de modos. Cada página es un `<webview>` con la partición `persist:codeai-web`
(cookies propias, separadas de la app), sin preload ni Node, `sandbox` y `contextIsolation` forzados en
`will-attach-webview`, y solo `http(s)`/`about:blank` (otros esquemas se bloquean o se abren fuera).
Permisos (cámara, notificaciones…) denegados salvo pantalla completa y copiar al portapapeles. Los
`target=_blank` y `window.open` abren una pestaña nueva del mismo visor; ⌘L/⌘T/⌘W/⌘R/⌘K funcionan con el
foco dentro de la página. Las pestañas se guardan por proyecto. *Abrir en una ventana nueva* crea una
`BrowserWindow` que carga el mismo renderer con `#web=<url>` (solo el visor), con opción de siempre encima.
Los enlaces del chat (también URLs sueltas y `localhost:puerto`) y de la terminal se abren aquí; ⌘-clic,
en el navegador.

## 7. Orquestador (modo Equipo)

`src/main/orchestrator/engine.ts` es una máquina de estados persistente:
`planning → awaiting_plan → running → integrating → testing → awaiting_approval → integrated`
(más `needs_user`, `failed`, `cancelled`, `interrupted`). Cada paso es una ejecución real de un CLI en una
sesión visible; planes y revisiones usan salida estructurada (`--json-schema` / `--output-schema`) y se
validan (`normalizePlan`: dependencias inexistentes, ciclos, reparto por modo). Cada agente tiene su worktree
(`codeai/<slug>/<agente>`); antes de una tarea dependiente se hace merge de la rama del otro agente. Revisión
cruzada con rondas limitadas, integración en un worktree propio, pruebas con lista blanca de comandos y,
al final, integración en la rama del usuario solo con su aprobación (squash o merge) y nunca sobre cambios
sin commit. Al reiniciar la app lo que estaba en marcha pasa a `interrupted` y se puede reanudar.

## 8. Seguridad

- Renderer con `contextIsolation` + `sandbox`, CSP estricta, navegación bloqueada, enlaces externos solo http(s).
- Visor web aislado (ver 6b); las páginas no pueden llamar al IPC de la app.
- Jev: descarga verificada con SHA-256, servidor solo en `127.0.0.1` con clave aleatoria, entorno mínimo.
- IPC con contrato tipado; las rutas de ficheros/Git se validan contra las raíces de proyectos abiertos y el
  directorio de worktrees de la app.
- `git` se ejecuta con `execFile` y una lista de subcomandos permitidos; nunca opciones `-c`/`--upload-pack`/`--exec`.
- Los modos sin restricciones (`bypassPermissions`, `danger-full-access`) se eligen por conversación en el selector de permisos y se marcan en amarillo.
- Actualización de la app (`src/main/app-update.ts`): el build graba la carpeta del clon y el commit (`__AMBIDEX_SOURCE__`, `__AMBIDEX_COMMIT__`); solo `git fetch` + `pull --ff-only` con el clon limpio y sin commits propios; `npm ci` solo si cambian `package.json`/`package-lock.json`; el instalador corre suelto al salir de la app.
- No se guardan credenciales: la autenticación la gestionan los CLI.
- Registro de auditoría de operaciones de Git, escrituras de ficheros, ejecuciones y cancelaciones.

## 9. Hitos

| Fase | Contenido | Criterio de "hecho" |
|---|---|---|
| **1. Base** ✅ | Electron 45, SQLite, pestañas multiproyecto con estado aislado y restaurado, chat real con Claude/Codex persistido en el proceso principal, detección de CLI/cuenta/modelos, login oficial, rediseño visual, paleta de comandos, tests | `npm test` (57) y `npm run test:e2e` (12 pasos con los CLI reales) en verde |
| **2. Desarrollo** ✅ | Explorador con búsqueda, varias terminales, Git visual, conflictos, cherry-pick/revert, PR con `gh`, diffs entre ramas | tests de Git con repos temporales |
| **3. Colaboración** ✅ | Chat único con enrutado, cola, orquestador persistente con modos A–E, worktree por agente, revisión cruzada, integración con aprobación | test del orquestador de punta a punta + `npm run test:e2e:team` con agentes reales |
| **4. Pulido** ✅ | Logo, `.app` firmada ad hoc, instancia única, apertura de carpetas desde el Dock, memoización del chat | E2E contra la app empaquetada |
| **5. Web, Jev y rendimiento** ✅ | Visor web con pestañas y ventanas flotantes, enlaces del chat, enrutado con Jev, Monaco/xterm bajo demanda, resaltado ligero, logo oficial de Codex | `npm test` (88), E2E 16/16 con agentes reales; Jev probado con una release simulada (el modelo real, pendiente de instalarlo) |
| **6. Paneles movibles** ✅ | Arrastrar paneles por la cabecera (intercambiar, a un lado, a todo lo ancho), interruptores y menú Diseño en la barra de título, disposición guardada por proyecto | `tests/dock.test.ts` (incluye 400 movimientos al azar sin solapes ni pérdidas) y paso E2E que arrastra la terminal sobre la web y comprueba que la shell y la página siguen vivas |
| **7. Más útil** ✅ | Diseños guardados, prompts con `/`, servidor de desarrollo, errores de la Web al chat, imágenes y capturas en el chat, deshacer un turno, conversaciones de fuera de la app, extensiones de cada CLI, los agentes manejan la Web (MCP), paneles en su propia ventana | `npm test` (121) y E2E con agentes reales que ven una imagen, deshacen un fichero creado por Claude y manejan la Web (Claude abre, pulsa y lee; Codex lee) |
