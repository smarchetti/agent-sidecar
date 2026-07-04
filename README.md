# agent-sidecar

[![CI](https://github.com/smarchetti/agent-sidecar/actions/workflows/ci.yml/badge.svg)](https://github.com/smarchetti/agent-sidecar/actions/workflows/ci.yml)
[![site](https://img.shields.io/badge/site-smarchetti.github.io%2Fagent--sidecar-d97757)](https://smarchetti.github.io/agent-sidecar/)

A visual canvas for Claude Code. This is a plain MCP server (no channels — works on orgs where channels are blocked) that runs a local web server so Claude can augment the conversation with rich, interactive HTML — and receive your clicks back as input.

Two things in one process:

1. **A visual space** — a browser canvas where Claude can publish HTML artifacts via the `create_artifact` / `update_artifact` tools. Artifacts appear live (SSE); new ones take focus automatically.
2. **A webhook receiver** — `POST /api/webhook` queues payloads for Claude and appends them to `.sidecar/interactions.jsonl`. Every artifact gets a `claude.send(payload)` helper injected, so buttons and forms inside an artifact can talk back to Claude.

## How responses reach Claude (without channels)

Claude can't receive pushed events when channels are org-blocked, so the sidecar offers two pull-based patterns:

- **Blocking tool (quick decisions)** — after showing an artifact, Claude calls `await_interaction`; the tool call blocks until you click something in the browser (or times out, in which case Claude calls it again). Passing the artifact's id filters out stale clicks on other artifacts.
- **Background watcher (long waits)** — Claude runs `curl -s "$url/api/wait?token=…&artifact_id=…"` as a background Bash task and keeps working; the harness re-invokes Claude with the payload when the watcher exits on your click.

Every interaction is also appended to `.sidecar/interactions.jsonl` as a durable audit log you can `tail -f` or have Claude read directly.

## Example flow

> "Help me design the settings screen."

1. Claude calls `create_artifact` with three visual design options, each with a **Choose this** button wired to `claude.send({ choice: 'option-b' })`.
2. Claude calls `await_interaction`, which blocks.
3. You click an option in the browser; the tool call returns with `{"choice":"option-b"}`.
4. Claude continues with the option you picked.

## Install as a plugin (recommended)

Requires [Bun](https://bun.sh) on your PATH (the plugin's MCP server runs with `bun`).

The repo doubles as its own plugin marketplace. In any Claude Code session:

```
/plugin marketplace add smarchetti/agent-sidecar   # or a local clone path
/plugin install sidecar@agent-sidecar
```

Restart Claude Code and the sidecar tools are available in every project. The plugin runs the committed `dist/sidecar.js` bundle — no `bun install` needed at install time. Session state (interaction log, canvas contents, session info) is written to `.sidecar/` in whatever project you're working in.

Then ask Claude for something visual, e.g. *"show me three layout options for a pricing page on the sidecar canvas."*

## Develop from source

```bash
bun install
bun test        # end-to-end suite (spawns the server over real MCP stdio)
```

To run your working copy, start Claude Code with the dev MCP config (it's deliberately *not* named `.mcp.json` — that would get auto-discovered inside installed plugin copies and double-register the server):

```bash
claude --mcp-config dev.mcp.json
```

After changing `sidecar.ts` or `canvas.html`, rebuild the plugin bundle:

```bash
bun run build   # regenerates dist/sidecar.js (committed — CI fails if it drifts from source)
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `create_artifact` | Publish a new HTML artifact to the canvas (opens the browser if no tab is connected) |
| `update_artifact` | Replace an artifact's HTML/title; connected tabs reload it live |
| `await_interaction` | Block until the user interacts (optionally filtered by `artifact_id`); returns the payload |
| `get_interactions` | Drain queued interactions without blocking |
| `list_artifacts` | List what's on the canvas |
| `remove_artifact` | Remove an artifact |

## HTTP endpoints & sessions

Each Claude Code session runs its own sidecar. The server prefers port `8765` (override with `SIDECAR_PORT`); if another session already holds it, it falls back to an ephemeral port instead of crashing. Each session writes its coordinates to `.sidecar/session.json` in the project:

```json
{ "pid": 12345, "port": 8765, "url": "http://127.0.0.1:8765", "token": "…", "startedAt": "…" }
```

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Canvas UI (sidebar of artifacts + live iframe viewer) |
| `GET /events` | SSE stream of artifact create/update/remove events |
| `GET /artifact/:id` | Rendered artifact with the `claude.send()` helper injected |
| `POST /api/webhook` | Queues the body for `await_interaction` / `/api/wait` (requires the session token) |
| `GET /api/wait` | Long-poll: blocks until the next interaction, returns it as JSON (requires token; `?artifact_id=` to filter, `?timeout=SECS` to cap, else waits indefinitely) |
| `GET /health` | `{ ok, artifacts, canvasTabs, queuedInteractions }` |

External systems (CI, scripts) can push events to Claude by reading `session.json`:

```bash
url=$(jq -r .url .sidecar/session.json); token=$(jq -r .token .sidecar/session.json)
curl -X POST -H "X-Sidecar-Token: $token" -d "build failed on main" "$url/api/webhook"
```

The token is also accepted as `?token=…` or an `Authorization: Bearer` header.

## Writing artifacts (for Claude)

Artifacts are complete HTML documents rendered in a **sandboxed** iframe (no network access, no storage — keep them self-contained with inline CSS/JS). A `claude` global is injected before your scripts run:

```html
<button onclick="claude.send({ choice: 'option-a' })">Choose A</button>
```

`claude.send()` returns a promise resolving to `true` on success, and the canvas shows a "✓ Sent to Claude" toast. Identical payloads within 1.5s are debounced, so double-clicks don't double-send.

## Security model

- **Localhost only** — the HTTP server binds `127.0.0.1`; nothing off the machine can reach it.
- **Per-session webhook token** — anything POSTed to `/api/webhook` is eventually placed in front of Claude, so the endpoint requires a random per-session token. Without it, any webpage you visit could fire cross-site POSTs at localhost and inject text into your session. The token lives in `.sidecar/session.json` (readable only by local processes, which are trusted anyway) and is injected into the canvas page.
- **Sandboxed artifacts** — artifact HTML runs in an opaque-origin iframe (`sandbox="allow-scripts allow-forms allow-popups"`). It can't touch the canvas shell, the token, or the network; its only output channel is `claude.send()`, which crosses a postMessage bridge that the canvas shell validates and forwards.
- Don't port-forward or tunnel this server.
