# Ambidex

<img src="build/icon.png" width="96" align="right" alt="Ambidex icon">

[![CI](https://github.com/DavLagoHern/Ambidex/actions/workflows/ci.yml/badge.svg)](https://github.com/DavLagoHern/Ambidex/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![macOS](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey)

**Claude Code and Codex, working as one.** · [Español](README.es.md)

Ambidex is a macOS desktop app for building software with **Claude Code** and **OpenAI Codex**: one at a time, side by side, or together in a single chat that decides who should handle each message. It runs the **official CLIs** you already have installed and signed in, so it works with your existing Claude and ChatGPT plans. No API keys, and it never stores credentials.

> **Early project.** macOS on Apple Silicon only, and the interface is in Spanish for now (English is planned).

> **Tauri 2 / Rust migration:** windows, PTYs, files and the WebKit viewer now use the Rust host. Agents, SQLite, Git and orchestration still run in one Node 24+ compatibility process. This is a hybrid migration; a complete Rust engine port remains pending. [Architecture, requirements and tests](docs/TAURI_MIGRATION.md).

## Highlights

- **One chat, two agents.** Each message goes to the agent best suited to it, based on:
  - the kind of task (decided by a small local model, [Jev](https://github.com/feder-cr/jev), or by Claude Haiku, or by rules);
  - who is busy, how much of each plan you have used, and whether the message continues the last one.

  The same decision also rates the task as hard or simple and picks the model you allowed for that case (by default Opus 5.5 or Sonnet 5.5 for Claude, GPT-6.1-Sol or GPT-6.1 Terra for Codex). Models you leave unticked are never used. Every reply says who answered, with which model, and why, and the agent that steps in gets the context of what was said with the other one.
- **Team mode.** For big tasks the agents plan, split the work and each work in their own git worktree. They review each other and run your tests. Nothing reaches your branch until you approve it.
- **Undo any agent turn.** Before and after every turn Ambidex snapshots your files as a git tree, using a temporary index. Your index, branches and history are never touched. Undo shows exactly which files would be restored or deleted, and skips the ones you changed afterwards.
- **CLIs kept up to date.** Every 6 hours Ambidex compares each CLI with the latest version on npm and installs a new one with the tool you used to install it (Homebrew, npm or the CLI's own `update`). It never updates a CLI while that agent is working, and you can turn it off.
- **Agents drive your browser tab.** A built-in web viewer is exposed to both agents through a local MCP server. They can:
  - open your `localhost`, read the page with numbered elements, click, type and press keys (real input events);
  - scroll, take screenshots and read console errors.

  You see a live banner while they do it, with a button to take control back. There is no tool to run arbitrary JavaScript.
- **See what the page sees.** Console errors and failed requests are counted next to the address bar; one click sends them to the chat. A camera button attaches a screenshot of the page. A ▶ button starts your `npm|pnpm|yarn|bun run dev` and opens its URL when the server prints it.
- **Images in the chat.** Paste, drag or pick images; both agents see them.
- **Pick up terminal sessions.** Ambidex lists the Claude Code and Codex conversations you started in a terminal or in VS Code for the same folder, and lets you continue them in the app. A Claude session that is still open elsewhere is continued in a fork, so the two never write to the same session.
- **Extensions at a glance.** Plugins, skills, subagents, commands, MCP servers, hooks and `CLAUDE.md`/`AGENTS.md` for each CLI, both yours and the project's. Secrets such as env values, headers and tokens are never shown.
- **Your layout.** Drag any panel by its header to swap it or dock it on a side. Save layouts, and pop the chat, terminal, editor or agent activity into their own window. A popped terminal stays the same shell.
- **Also included:**
  - a Monaco editor and terminals;
  - Git: multi-repo, staging, branches, conflicts, cherry-pick and revert, pull requests via `gh`;
  - messages sent while an agent works go straight to an editable queue; from there you add them to the current turn (without stopping it), hand them to the other agent, or leave them for Jev to route when it's free; **+** / ⌘↵ launches the message as a separate task, and `/prompts`;
  - the state of every project, restored when you reopen it.

## Install from source

Requirements:
- macOS 14+ on Apple Silicon
- Node 24+ and Rust stable (with Xcode command line tools)
- Git
- [Claude Code](https://code.claude.com) and/or [Codex CLI](https://github.com/openai/codex), installed and signed in

```bash
git clone https://github.com/DavLagoHern/Ambidex.git
cd Ambidex
npm install            # frontend dependencies + Tauri CLI
npm run dist           # builds and packages Ambidex.app (signed with your keychain identity, or ad hoc)
npm run install:app    # copies it to /Applications, adds a Desktop shortcut and opens it
```

From then on it updates itself: when it opens (and every 6 hours) it runs `git pull --ff-only` in that same clone, builds the new version in the background and offers **Restart** (otherwise it installs when you quit). It never touches a clone with uncommitted changes or local commits; it tells you in **Ajustes → Agentes** instead. You can turn it off; the log is in `logs/update.log`.

The app is signed with the first Apple Development / Developer ID identity in your keychain (or `AMBIDEX_SIGN_IDENTITY`), so macOS remembers its permissions (such as Documents access) across rebuilds; without one it falls back to ad hoc, which macOS treats as a new app on every build. Either is fine for a build made on your own Mac; there are no notarized downloads yet. If a CLI is not signed in, **Ajustes → Agentes y cuentas** opens its official login in a real terminal inside the app. For development, run `npm run dev`.

## How it works

- **CLIs as child processes.** Claude uses `claude -p` with bidirectional `stream-json`; Codex chats use `codex app-server` with `turn/steer` to accept input during active turns. Structured output jobs retain `codex exec --json`.
  - The prompt goes through stdin, and arguments are always arrays, never a shell string.
  - Every event is stored in SQLite before it reaches the UI, so a crash or reload loses nothing.
  - Cancelling stops the whole process group.
- **Images.** Claude receives them as content blocks (`--input-format stream-json`) and Codex as `localImage` input items (`--image` for structured output jobs). Only files from the app's own attachments folder can be sent.
- **Web tools.** A tiny MCP server (streamable HTTP, `127.0.0.1` only) is added to each turn with `--mcp-config` for Claude and `-c mcp_servers.*` for Codex. Your CLI configuration files are never modified. Each turn gets its own token in an environment variable, and the token expires when the turn ends.
- **Undo.** Snapshots are `git add -A` into a temporary copy of the index followed by `git write-tree`: no commits and no refs.
- Architecture notes (in Spanish): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

- The renderer is sandboxed. File paths are checked against the projects you opened, including through symlinks.
- Web pages have no preload and no Node access, use their own session, can only navigate `http(s)`, and get device permissions denied.
- The MCP server:
  - rejects requests that carry an `Origin` header (a web page) or a foreign `Host` (DNS rebinding);
  - rejects tokens from turns that have ended.
- Git commands from the UI use an allow-list and block `-c`, `--upload-pack`, `--exec` and similar options.
- Destructive actions ask for native confirmation.
- Nothing is merged into your branch or pushed without an explicit action from you.

## Subscriptions and terms

Ambidex launches the official CLIs with your own sign-in. What your plan covers is decided by each provider's terms, which changed several times in 2026.
- As of November 2026, Anthropic's help center says `claude -p` usage still draws from your subscription limits ([article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
- For Codex, see [OpenAI's help center](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan-usage-limits-and-troubleshooting).

Check both before relying on Ambidex for heavy use.

## Tests

```bash
npm run typecheck
npm run test:native
npm run build:assets
npm test                                # 187 unit tests, no quota used
cargo build --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml && npm run test:e2e       # native integration tests with simulated CLIs (no quota)
```

The CLI adapters are tested against output captured from Claude Code 2.1.316 and Codex 0.155.1.

## Known limitations

- **Platform and language:** macOS on Apple Silicon only, and the UI is in Spanish.
- **Permissions:** the CLIs run non-interactively, so anything that needs permission is denied, and the chat explains how to allow it. There is no live approval prompt.
- **Undo:** only works in git repositories.
- **Jev:** takes about 0.7 s per decision on an M-series Mac. If it doesn't answer in time, the rules decide and the simple-task model is used; the hard-task model needs Jev to rate the message hard with at least 30 % confidence. On a set of 25 sample requests it rated difficulty correctly in 22.
- **CLI changes:** the output formats of the CLIs change often, and new versions may need adapter updates.

## Credits

[Jev](https://github.com/feder-cr/jev) (MIT) for local routing decisions. Built with Tauri 2, Rust, WebKit, React, Monaco, xterm.js and Lucide, with a headless Node compatibility engine.

## License

[MIT](LICENSE). Ambidex is an independent project and is not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; Codex and ChatGPT are trademarks of OpenAI.
