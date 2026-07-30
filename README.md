# ✳ agent-sidecar

[![CI](https://github.com/smarchetti/agent-sidecar/actions/workflows/ci.yml/badge.svg)](https://github.com/smarchetti/agent-sidecar/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-sidecar?color=d97757)](https://www.npmjs.com/package/agent-sidecar)
[![docs](https://img.shields.io/badge/docs-agent--sidecar.vercel.app-d97757)](https://agent-sidecar.vercel.app/docs.html)

**A visual canvas for coding agents.** Your agent shows you interactive HTML — design options, forms, previews, dashboards — in your browser, and your clicks flow straight back into the conversation. Works with Claude Code, Cursor, Codex, or any MCP client.

[![The loop: a terminal asks for design options, a glowing canvas shows three choices, the click flows back as JSON](https://agent-sidecar.vercel.app/og.png)](https://agent-sidecar.vercel.app/)

> *"Show me three layout options for the settings screen"* → three clickable mockups appear on the canvas → you click one → Claude continues with your choice.

agent-sidecar is an MCP server plus a local canvas server, packaged as a Claude Code plugin — and usable from [any MCP client](#use-with-other-agents). One canvas server runs per machine and every agent session attaches to it, so all your sessions share one browser tab and you switch between them in the sidebar. It needs no push mechanism (works on orgs where Claude Code channels are blocked): the browser-to-agent return path is a long-poll the server turns into ordinary tool output.

**Website & full docs → [agent-sidecar.vercel.app](https://agent-sidecar.vercel.app/)** ([documentation](https://agent-sidecar.vercel.app/docs.html))

## Quick start

Requires [Bun](https://bun.sh) on your PATH. In any Claude Code session:

```
/plugin marketplace add smarchetti/agent-sidecar
/plugin install agent-sidecar@agent-sidecar
```

Restart Claude Code, then ask for something visual: *"show me three layout options for a pricing page on the canvas."* The browser opens, the artifact renders, and clicking it answers Claude.

## Use with other agents

agent-sidecar is a standard MCP stdio server, so any MCP client can run it — the plugin is just Claude Code packaging. Point your agent at:

```json
{ "mcpServers": { "agent-sidecar": { "command": "bunx", "args": ["agent-sidecar"] } } }
```

| Agent | Config file |
| --- | --- |
| Cursor | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| VS Code (Copilot) | `.vscode/mcp.json` — same entry under a `"servers"` key |
| Codex CLI | `~/.codex/config.toml` — `[mcp_servers.agent-sidecar]` with `command`/`args` |
| Gemini CLI | `~/.gemini/settings.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

Everything transfers: the tools, the canvas, the token auth, the `.sidecar/` files. Two Claude-flavored details to know: the injected browser helper is still named `claude.send()`, and the background-watcher pattern requires an agent that can run shell commands in the background — the blocking `await_interaction` tool works everywhere.

## How it works

One canvas server, any number of agent sessions:

```
Claude Code (project A) ⇄ MCP/stdio ⇄ ┐
Claude Code (project B) ⇄ MCP/stdio ⇄ ┤→ agent-sidecar server ⇄ HTTP 127.0.0.1:8765 ⇄ browser canvas
Cursor      (project A) ⇄ MCP/stdio ⇄ ┘   (one detached process)   │
                                                                  └── POST /api/webhook ← CI, scripts, anything
```

1. **Claude shows** — `create_artifact` puts a complete HTML document on the canvas (SSE-live; updates hot-reload). Artifacts belong to the session that made them.
2. **You click** — every artifact gets a `claude.send(payload)` helper injected. It crosses a postMessage bridge out of the sandboxed iframe; the canvas shell forwards it to the webhook with the server token.
3. **Claude continues** — either a blocking `await_interaction` call returns your payload in-turn (quick decisions), or a background `curl /api/wait` watcher re-invokes Claude when you click (long waits, Claude keeps working meanwhile).

Interactions are routed back to the session that owns the artifact you clicked, so parallel sessions never read each other's answers. Each session's interactions are appended to its own project's `.sidecar/interactions.jsonl` — a durable, `tail -f`-able audit log.

## Sessions on the canvas

The sidebar is a tree: **project → session → artifacts**. Each session is labelled with its git branch and lists its own artifacts nested beneath it, so you can see everything on the canvas at once and jump straight to any artifact — collapse a session with its ▾ to get it out of the way. A status bar along the bottom reports the connection, the server address, live/total sessions, artifact and queued-reply counts, and the running version. A session that ends stays on the canvas (dimmed) so you can still read what it produced, until you dismiss it. When an artifact arrives in a session you're *not* looking at, that session gets a badge and a clickable toast — the view never jumps out from under an interaction you're in the middle of.

The server outlives your agent sessions, and exits on its own after 30 minutes with no sessions and no open canvas tab. To manage it directly:

```bash
bunx agent-sidecar --status   # server, sessions, artifact counts
bunx agent-sidecar --stop     # shut it down
bunx agent-sidecar --serve    # run it in the foreground (debugging)
```

## Reference (short version)

**MCP tools** — `create_artifact`, `update_artifact`, `await_interaction` (blocking, `artifact_id` filter), `get_interactions` (drain), `list_artifacts`, `remove_artifact`.

**HTTP** — `GET /` canvas · `GET /events` SSE · `GET /artifact/:id` · `POST /api/webhook` (token) · `GET /api/wait?session=…` long-poll (token) · `GET /health`.

**Files** — machine-wide state in `~/.agent-sidecar/` (`server.json` coordinates, `state.json` canvas contents, `server.log`); per-project state in `.sidecar/` (`session.json` coordinates for external callers, `interactions.jsonl`). Env: `SIDECAR_PORT` (default 8765), `SIDECAR_HOME`, `SIDECAR_IDLE_EXIT_MS`.

External systems push events in by reading the coordinates from either file:

```bash
url=$(jq -r .url .sidecar/session.json); token=$(jq -r .token .sidecar/session.json)
sid=$(jq -r .sessionId .sidecar/session.json)   # omit to land on the session you're viewing
curl -X POST -H "X-Sidecar-Token: $token" -d "build failed on main" "$url/api/webhook?session=$sid"
```

Full parameter tables, artifact-authoring patterns, and the security model are in the **[docs](https://agent-sidecar.vercel.app/docs.html)**.

## Security in one paragraph

Localhost-only binding; a random token (stored `0600` in `~/.agent-sidecar/server.json`) required on every `/api/*` endpoint (defeats cross-site POSTs from web pages at localhost); artifacts run in an opaque-origin sandboxed iframe with no access to the token, the canvas shell, storage, or same-origin network — `claude.send()` is their only output channel. Don't tunnel or port-forward the server: anything that reaches the webhook is eventually placed in front of Claude. [Details.](https://agent-sidecar.vercel.app/docs.html#security)

## Development

```bash
bun install
bun test                              # 38 end-to-end tests over real MCP stdio
claude --mcp-config dev.mcp.json      # run your working copy live (disable the plugin first)
```

Tests run against an isolated server (`SIDECAR_HOME` + a random port), so they never touch the one you're using.

Source: `src/sidecar.ts` (CLI entry) · `src/server.ts` (the singleton canvas server) · `src/client.ts` (server discovery + session link) · `src/mcp.ts` (the tools) · `src/shared.ts` (paths and types) · `src/canvas.html` (the browser shell, inlined into the bundle). Releases: bump `package.json`, the `agent-sidecar@<version>` pin in `.claude-plugin/plugin.json`, and CHANGELOG, then push and tag `vX.Y.Z` — GitHub Actions tests, publishes to npm with provenance, and cuts the release.

## License

MIT
