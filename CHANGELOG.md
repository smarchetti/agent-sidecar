# Changelog

## 0.9.0 — 2026-07-28

**One canvas server per machine, sessions separated in the UI.** Previously every agent session started its own server on its own port, which meant a browser tab per session and a canvas that died with the session.

- **Singleton server.** The first session starts a detached server on port `8765`; every later session — in any project, from any MCP client — attaches to it as a thin client. It outlives your sessions and exits on its own after 30 minutes with no sessions and no canvas tab (`SIDECAR_IDLE_EXIT_MS` to change, `0` to disable).
- **Sessions in the canvas.** The sidebar lists every session grouped by project and labelled with its git branch; picking one shows its artifacts. Ended sessions stay (dimmed) until dismissed, so you can still read what they produced.
- **No focus stealing.** An artifact arriving in a session you aren't watching badges that session and shows a clickable toast instead of yanking the view. Within the session you're watching, new artifacts take focus as before.
- **Interaction routing.** Interactions go to the session that owns the clicked artifact; canvas notes and unaddressed webhooks go to the session you're viewing. `GET /api/wait` and `/api/drain` take a `session=` param and refuse an unknown one rather than serving another session's queue.
- **New CLI:** `--status`, `--stop`, `--serve`, `--help`.
- **State moved:** machine-wide `~/.agent-sidecar/` (`server.json`, `state.json`, `server.log`) plus per-project `.sidecar/` (`session.json` now includes `sessionId` and `serverPid`; `interactions.jsonl` unchanged). `artifacts.json` is gone — the canvas is persisted centrally.
- **Survives a server restart.** Sessions reclaim their id and artifacts, and the auth token is reused, so background watcher URLs Claude was already given keep working.
- Source split into `server.ts` / `client.ts` / `mcp.ts` / `shared.ts`; the test suite grew to 38 tests and runs against an isolated server.

Tool names, schemas, and the `claude.send()` contract are unchanged.

## 0.8.0 — 2026-07-05

- **Canvas composer**: a free-text input in the canvas shell — tell your agent something from the browser anytime, no artifact required. Notes arrive as a new `note` interaction kind, attributed to the user, and are skipped by artifact-filtered waits.
- **Canvas restyled** to the ember/ink brand (system fonts, works offline).
- **Artifact quality bar** added to the server instructions, so agents produce well-designed artifacts by default (layout, accent discipline, button sizing, confirmation states).
- Releases now publish to npm automatically via GitHub Actions trusted publishing with provenance (tag push → test → publish → GitHub release).
- Site: OpenGraph/Twitter cards with a hero image, styled 404 page. CI runs on macOS and Linux.

## 0.7.0 — 2026-07-05

- Rebrand: the plugin, MCP server, and canvas are all named **agent-sidecar** now (install is `/plugin install agent-sidecar@agent-sidecar`; tool prefix becomes `mcp__plugin_agent-sidecar_agent-sidecar__`). Existing installs of the old `sidecar` plugin should uninstall and reinstall. Technical identifiers (`.sidecar/` directory, `SIDECAR_PORT`, `X-Sidecar-Token`) are unchanged.
- Docs: install instructions for other MCP clients (Cursor, VS Code, Codex CLI, Gemini CLI, Windsurf) on the site and in the README.

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
