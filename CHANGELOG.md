# Changelog

## 0.6.0 — 2026-07-04

- Distribution moved to npm: the plugin manifest now launches `bunx agent-sidecar@<version>` instead of running a bundle committed in the repo. `dist/` is no longer tracked in git (built by `prepublishOnly` at publish time), and the CI drift check is gone.

## 0.5.0 — 2026-07-04

- New `GET /api/wait` long-poll endpoint: blocks until the next interaction and returns it as JSON (token-gated; `artifact_id` filter, optional `timeout` cap, waits indefinitely by default). Lets Claude run a background `curl` watcher and keep working instead of parking on the blocking tool — server instructions now teach both patterns and include the ready-to-run command.

## 0.4.0 — 2026-07-03

Production hardening.

### Security
- `POST /api/webhook` now requires a random per-session token (header `X-Sidecar-Token`, `?token=`, or `Authorization: Bearer`), closing a cross-site request forgery hole where any webpage could inject text in front of Claude via localhost POSTs.
- Artifact iframes are sandboxed (`allow-scripts allow-forms allow-popups`, opaque origin). `claude.send()` now crosses a postMessage bridge validated and forwarded by the canvas shell, which holds the token; artifact code never sees it.

### Reliability
- Multiple sessions coexist: if the preferred port (default 8765) is taken, the server falls back to an ephemeral port instead of crashing. Each session writes `.sidecar/session.json` (pid, port, url, token) for discovery by external callers.
- Canvas contents persist to `.sidecar/artifacts.json` and are restored on restart.
- `await_interaction` accepts `artifact_id` to filter, so stale clicks on other artifacts can't be misread as the answer.
- `claude.send()` debounces identical payloads within 1.5s (double-click protection).
- Canvas reconnects jump to the newest artifact instead of staying pinned to the URL-hash one.
- `interactions.jsonl` rotates at 5MB.
- Browser auto-open works on macOS, Linux, and Windows.

### Tooling
- End-to-end test suite in-repo (`bun test`), exercising the server over real MCP stdio.
- CI workflow: tests plus a check that the committed `dist/sidecar.js` matches the source.
- Landing page deploys to GitHub Pages.

## 0.3.0 — 2026-07-03

- Packaged as a Claude Code plugin: self-contained `dist/sidecar.js` bundle, `.claude-plugin/plugin.json` manifest, and a marketplace file so the repo installs directly.
- Interaction log moved to the project working directory.
- MIT license.

## 0.2.0 — 2026-07-03

- Channel-free rewrite for orgs where channels are blocked: interactions queue for a long-poll `await_interaction` tool and append to `.sidecar/interactions.jsonl`.

## 0.1.0 — 2026-07-03

- Initial MCP channel server: visual canvas with SSE live updates, artifact tools, webhook receiver, injected `claude.send()` helper.
