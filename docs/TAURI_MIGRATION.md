# Tauri migration

Ambidex now builds with Tauri 2 and a Rust desktop host. The UI still uses React,
Monaco and xterm.js. The application does not bundle Electron, Chromium, node-pty
or a Node runtime.

This is a **hybrid migration**, not a complete Rust rewrite. The tested agent,
Git, SQLite, routing, queue, Jev and orchestration implementations still run in
one headless Node 24+ process that is closed after 30 seconds of inactivity and restarted on demand. That process is a compatibility engine, packaged
as `Resources/engine/index.mjs`; it is not a web server and has no Electron
imports. Porting those modules to Rust remains separate work. Do not describe
this implementation as a fully native Rust backend or promise a RAM reduction
without measuring the whole process group, including WebKit helpers.

## Native services

`src-tauri/src` owns the application lifecycle, IPC origin checks, window and
panel creation, system dialogs and menus, isolated WebKit child views, file
access, image attachments, recursive file watching and terminal PTYs. Image attachments cross IPC as raw bytes, avoiding the heap growth from large JSON arrays. Rust
validates paths after resolving symlinks, including paths that do not exist yet.
The main app and guest browser views have separate permissions. Guest pages
cannot invoke application commands, listen to project events, or access files.

The renderer keeps its typed IPC contract. Calls cross Tauri's command boundary
and native services are handled in Rust. Other calls go over private stdin and
stdout pipes to the compatibility engine. Pushes are delivered only to local
application views. The engine persists the same messages and runs as before.
A read/write lease prevents idle shutdown during requests; active turns, orchestration phases, installers and pending application updates prevent parking. Native browser state and persisted agent metadata are restored on wake. Rust keeps periodic account and update checks running while the engine sleeps.

Quit first cancels agents and terminates terminals, then closes the database.

The workspace and browser use separate WebKit data stores, derived from the data directory. Disposable test profiles therefore have their own localStorage and cookies. Existing Electron browser cookies
cannot be reused by WebKit; browser sign-ins may need to be repeated. Conversation
history, projects, worktrees, settings, attachments and CLI authentication retain
their existing locations. CLI auth files are never copied or modified by this
migration.

## Data compatibility

On macOS, the host uses `~/Library/Application Support/Ambidex`. If only the old
`Code AI` directory exists, it continues using that directory. `code-ai.db` is
preferred when present, otherwise `ambidex.db` is used. The published SQLite
schema and migrations are unchanged. `AMBIDEX_USER_DATA` selects isolated data
for tests. Close the old Electron app before opening the native build against the same data. The Rust host checks for an existing Electron process before starting the engine.

The legacy Electron entry points remain in source for reference but
are excluded from the Tauri build; they are not shipped in the application.

## Build and validation

Requirements: macOS 14+ on Apple Silicon, Xcode command line tools, Rust 1.90+,
Node.js 24+, npm, Git, and the official agent CLIs. Node is needed by the agent
compatibility engine at runtime. Finder launches search PATH, Homebrew, Volta,
mise and nvm locations; `AMBIDEX_NODE_BIN` overrides discovery.

```sh
npm ci
npm run dev                 # Tauri + Vite
npm run typecheck
npm test                    # existing engine, routing, Git and persistence suite
npm run test:native         # Rust path containment and PTY buffer tests
npm run build               # assets + optimized native application bundle
npm run dist                # src-tauri/target/release/bundle/macos/Ambidex.app
npm run dist:dmg
npm run install:app
```

Seventeen native integration checks run the real Rust host and WebKit, using disposable
repositories, an isolated database, a loopback web page and simulated CLIs. They cover engine sleep/wake, persistence after exit, one-time delivery of commands across windows, deferred Monaco loading, native title-bar double click and resize, and contained review tabs/diffs at 640 px:

```sh
npm run build:assets
cargo build --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml
npm run test:e2e
```

The native test driver is gated by a debug build and explicit test environment
variables. Its control endpoints are absent from release builds. Original
Electron Playwright scripts are retained as reference; the default E2E command
now runs the native test suite.

Release builds use LTO, one codegen unit, size optimization and stripped symbols.
Monaco, its CSS and workers load only when a file or diff is opened; an empty editor panel stays lightweight. xterm also loads on demand. Window bounds are saved directly by Rust, with a debounce, so moving or resizing a window does not wake the agent engine.

No native Node addon is built
at installation. Compare packaged applications with the same project, layout,
agent state and browser tabs; disk size and resident/physical memory are distinct
measurements.

## Local measurement, 2026-11-06

One idle sample on macOS 27.0.1 / Apple Silicon, with separate copies of the same
project data, 66 seconds after launch. Physical memory includes the application
and its own renderer, GPU and networking helpers; the Node engine was asleep.

| Build | Packaged size | Physical memory in idle chat |
| --- | ---: | ---: |
| Previous Electron build | 270.7 MiB | 151.9 MiB |
| Tauri / Rust host | about 11.8 MiB | 133.2 MiB |

This sample shows about 96% less disk space and 12% less idle memory. Memory gains
are moderate in this profile; do not describe them as a several-fold improvement.
Agent and editor workloads differ, and startup or inference speed was not
benchmarked. The empty editor additionally defers Monaco until a file or diff is
opened. [Machine-readable result](tauri-benchmark.json).

Reproduce with `node scripts/benchmark-native.mjs <isolated seeded data directory>`.
The native E2E test prints a suitable disposable data directory. The script uses
Launch Services and the macOS responsible-process PID to include only the
application's own WebKit helpers, then runs `footprint`.
