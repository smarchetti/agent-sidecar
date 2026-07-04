# agent-sidecar

A visual canvas for Claude Code. This is a plain MCP server (no channels — works on orgs where channels are blocked) that runs a local web server so Claude can augment the conversation with rich, interactive HTML — and receive your clicks back as input.

Two things in one process:

1. **A visual space** — a browser canvas at `http://127.0.0.1:8765` where Claude can publish HTML artifacts via the `create_artifact` / `update_artifact` tools. Artifacts appear live (SSE); new ones take focus automatically.
2. **A webhook receiver** — `POST /api/webhook` queues payloads for Claude and appends them to `.sidecar/interactions.jsonl`. Every artifact gets a `claude.send(payload)` helper injected, so buttons and forms inside an artifact can talk back to Claude.

## How responses reach Claude (without channels)

Claude can't receive pushed events when channels are org-blocked, so the sidecar uses a **long-poll tool** instead. After showing an artifact that expects input, Claude calls `await_interaction` — the tool call blocks until you click something in the browser (or times out, in which case Claude calls it again). Every interaction is also appended to `.sidecar/interactions.jsonl` as a durable audit log you can `tail -f` or have Claude read directly.

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

Restart Claude Code and the sidecar tools are available in every project. The plugin runs the committed `dist/sidecar.js` bundle — no `bun install` needed at install time. Interaction logs are written to `.sidecar/` in whatever project you're working in.

Then ask Claude for something visual, e.g. *"show me three layout options for a pricing page on the sidecar canvas."*

## Develop from source

```bash
bun install
```

To run your working copy, start Claude Code with the dev MCP config (it's deliberately *not* named `.mcp.json` — that would get auto-discovered inside installed plugin copies and double-register the server):

```bash
claude --mcp-config dev.mcp.json
```

After changing `sidecar.ts` or `canvas.html`, rebuild the plugin bundle:

```bash
bun run build   # regenerates dist/sidecar.js (committed — plugin installs run this file)
```

Don't run the plugin and the source version in the same session — they'd fight over port 8765.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `create_artifact` | Publish a new HTML artifact to the canvas (opens the browser if no tab is connected) |
| `update_artifact` | Replace an artifact's HTML/title; connected tabs reload it live |
| `await_interaction` | Block until the user interacts with an artifact (or an external POST arrives); returns the payload |
| `get_interactions` | Drain queued interactions without blocking |
| `list_artifacts` | List what's on the canvas |
| `remove_artifact` | Remove an artifact |

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Canvas UI (sidebar of artifacts + live iframe viewer) |
| `GET /events` | SSE stream of artifact create/update/remove events |
| `GET /artifact/:id` | Rendered artifact with the `claude.send()` helper injected |
| `POST /api/webhook` | Queues the body for `await_interaction` and logs it to `.sidecar/interactions.jsonl` |
| `GET /health` | `{ ok, artifacts, canvasTabs, queuedInteractions }` |

Set `SIDECAR_PORT` to change the port (default `8765`).

## Writing artifacts (for Claude)

Artifacts are complete HTML documents rendered in an iframe. A `claude` global is injected before your scripts run:

```html
<button onclick="claude.send({ choice: 'option-a' })">Choose A</button>
```

`claude.send()` returns a promise resolving to `true` on success, and the canvas shows a "✓ Sent to Claude" toast.

## Security notes

- The HTTP server binds `127.0.0.1` only — nothing off the machine can reach it.
- Anything POSTed to `/api/webhook` is eventually placed in front of Claude, which makes an open endpoint a prompt-injection vector. Localhost-only binding is the mitigation here; don't port-forward or tunnel this server.
