# ✳ agent-sidecar

[![CI](https://github.com/smarchetti/agent-sidecar/actions/workflows/ci.yml/badge.svg)](https://github.com/smarchetti/agent-sidecar/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-sidecar?color=d97757)](https://www.npmjs.com/package/agent-sidecar)
[![docs](https://img.shields.io/badge/docs-smarchetti.github.io-d97757)](https://smarchetti.github.io/agent-sidecar/docs.html)

**A visual canvas for Claude Code.** Claude shows you interactive HTML — design options, forms, previews, dashboards — in your browser, and your clicks flow straight back into the conversation.

> *"Show me three layout options for the settings screen"* → three clickable mockups appear on the canvas → you click one → Claude continues with your choice.

Sidecar is an MCP server with an embedded web server, packaged as a Claude Code plugin. It needs no push mechanism (works on orgs where Claude Code channels are blocked): the browser-to-Claude return path is a long-poll the server turns into ordinary tool output.

**Website & full docs → [smarchetti.github.io/agent-sidecar](https://smarchetti.github.io/agent-sidecar/)** ([documentation](https://smarchetti.github.io/agent-sidecar/docs.html))

## Quick start

Requires [Bun](https://bun.sh) on your PATH. In any Claude Code session:

```
/plugin marketplace add smarchetti/agent-sidecar
/plugin install sidecar@agent-sidecar
```

Restart Claude Code, then ask for something visual: *"show me three layout options for a pricing page on the canvas."* The browser opens, the artifact renders, and clicking it answers Claude.

## How it works

One process, two faces:

```
Claude Code  ⇄ MCP/stdio ⇄  sidecar  ⇄ HTTP 127.0.0.1 ⇄  browser canvas
                              │
                              └── POST /api/webhook  ←  CI, scripts, anything
```

1. **Claude shows** — `create_artifact` puts a complete HTML document on the canvas (SSE-live; new artifacts take focus, updates hot-reload).
2. **You click** — every artifact gets a `claude.send(payload)` helper injected. It crosses a postMessage bridge out of the sandboxed iframe; the canvas shell forwards it to the webhook with the session token.
3. **Claude continues** — either a blocking `await_interaction` call returns your payload in-turn (quick decisions), or a background `curl /api/wait` watcher re-invokes Claude when you click (long waits, Claude keeps working meanwhile).

Every interaction is also appended to `.sidecar/interactions.jsonl` — a durable, `tail -f`-able audit log.

## Reference (short version)

**MCP tools** — `create_artifact`, `update_artifact`, `await_interaction` (blocking, `artifact_id` filter), `get_interactions` (drain), `list_artifacts`, `remove_artifact`.

**HTTP** — `GET /` canvas · `GET /events` SSE · `GET /artifact/:id` · `POST /api/webhook` (token) · `GET /api/wait` long-poll (token) · `GET /health`.

**Sessions** — each Claude Code session runs its own sidecar: port `8765` preferred, ephemeral fallback if taken. Coordinates (port, URL, auth token) live in `.sidecar/session.json`, which is how external systems push events in:

```bash
url=$(jq -r .url .sidecar/session.json); token=$(jq -r .token .sidecar/session.json)
curl -X POST -H "X-Sidecar-Token: $token" -d "build failed on main" "$url/api/webhook"
```

Full parameter tables, artifact-authoring patterns, and the security model are in the **[docs](https://smarchetti.github.io/agent-sidecar/docs.html)**.

## Security in one paragraph

Localhost-only binding; a random per-session token required on `/api/webhook` and `/api/wait` (defeats cross-site POSTs from web pages at localhost); artifacts run in an opaque-origin sandboxed iframe with no access to the token, the canvas shell, storage, or same-origin network — `claude.send()` is their only output channel. Don't tunnel or port-forward the server: anything that reaches the webhook is eventually placed in front of Claude. [Details.](https://smarchetti.github.io/agent-sidecar/docs.html#security)

## Development

```bash
bun install
bun test                              # 24 end-to-end tests over real MCP stdio
claude --mcp-config dev.mcp.json      # run your working copy live (disable the plugin first)
```

Source is `src/sidecar.ts` (the whole server) and `src/canvas.html` (the browser shell, inlined into the bundle). Releases: bump `package.json` and the `agent-sidecar@<version>` pin in `.claude-plugin/plugin.json`, then `npm publish` — publish **before** pushing, so the manifest never points at an unpublished version.

## License

MIT
