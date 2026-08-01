# Changelog

## 0.12.0 — 2026-07-31

**Runs on plain Node, ships inside the plugin, and stops pretending one version describes everything.**

- **No more Bun prerequisite.** `src/` uses only `node:` builtins now, the bundle is built with `--target=node`, and the plugin launches it with `node`. Requiring Bun on every user's PATH was the biggest install-funnel tax; Node is already on essentially every machine that has Claude Code. Bun remains the tooling — `bun install`, `bun test`, `bun build` — it is just no longer a runtime dependency for anyone installing this. `Bun.serve` became `node:http` behind a small Request/Response adapter, and `Bun.spawn`/`Bun.file`/`Bun.sleep`/`import.meta.path` became their `node:` equivalents.
  - Two runtime differences worth recording: node's `requestTimeout` defaults to 5 minutes and would have severed SSE streams and indefinite long-polls, so it is disabled explicitly; and bun's `node:http` shim never emits response `'close'` when a peer dies (it emits request `'aborted'` instead), which silently broke session liveness until the adapter listened for both. CI now runs the whole suite twice — the working source under bun, the built bundle under node — because that class of disagreement is invisible to a single-runtime test run.
- **The plugin carries its own bundle.** `.claude-plugin/plugin.json` runs `node ${CLAUDE_PLUGIN_ROOT}/dist/sidecar.js` instead of `bunx agent-sidecar@<version>`, so installing the plugin no longer touches the npm registry, works offline and behind a corporate proxy, and cannot start slowly on a cold cache. `dist/sidecar.js` is committed for that reason, and CI fails if it has drifted from `src/`. npm remains the distribution channel for every other MCP client (`npx -y agent-sidecar`, or a global install on locked-down networks).
- **The client↔server contract has its own version.** `PROTOCOL` (currently `1`) covers the HTTP surface between an MCP client and the canvas server, and moves only when that surface breaks — separately from the package version, which moves every release. A 0.11 client and a 0.12 server share a canvas quite happily, so shipping a release no longer implies restarting a server out from under live sessions. Servers on incompatible protocols coexist instead of fighting: the discovery file is protocol-scoped (`server.json` stays the protocol-1 name), and the port scan steps past a sidecar that isn't speaking our protocol rather than assuming we lost a startup race.
- **Sessions report the version of their own client half.** Registration now carries `version`, `protocol`, and the `entry` path the client was launched from. Previously the canvas showed one version — the server's — which was misleading with two harnesses pinning different releases: opening a Claude artifact could show Cursor's version in the corner. The sidebar now marks a session with its own version when it differs from the server's, `GET /api/sessions` and the canvas snapshot include it, and `--status` prints both.
- **A stale server nobody is watching is replaced, not adopted.** Starting a client against an older server that has nothing attached and no canvas tab open stops it and starts the newer one first — the ordinary "upgrade the plugin, restart your editor" path, invisible because there was nothing to disturb. A server with anything attached is never restarted automatically.
- **The canvas offers the restart instead of taking it.** When a live session is running newer code than the server, an update bar appears saying which versions are in play and how many live sessions will reconnect. `POST /api/restart` hands off to the newest `entry` a session has registered from: it persists state, releases the port, launches the successor, and exits, so the canvas URL never moves and clients re-attach on their own. Restarting was always safe — state persists and clients reconnect — but it is visible, so it stays a decision rather than a background surprise.
- `GET /health` gained `protocol` and `idle`; `POST /api/sessions` returns `protocol`; `--status` prints the protocol and flags when the running server is a different release from the CLI asking.

**Upgrading:** if you installed the plugin, `/plugin marketplace update` then `/plugin install` — you can uninstall Bun as far as this project is concerned. If you wired the MCP server up by hand, swap `bunx agent-sidecar` for `npx -y agent-sidecar`; the old form keeps working, since the bundle runs under either runtime.

## 0.11.0 — 2026-07-31

**Grouped by repo and worktree, a timeline view of each session, and light/dark themes.**

- **Grouped by repo and worktree.** The sidebar tree is now repo → worktree → session → artifacts. Sessions in two `git worktree` checkouts of the same repo group under one repo instead of appearing as unrelated projects: identity comes from the main worktree's git dir (`--git-common-dir`), and the display name from the `origin` remote when there is one. The worktree level is shown only when a repo has more than one checkout, so single-checkout repos stay exactly as flat as before. A cwd that isn't a repo still gets its own group, marked `dir`.
- Session breadcrumbs, canvas notes, toasts, and `--status` name the worktree when it isn't the repo's main checkout (`brain/bra-72-evidence · feat/x`).
- **Timeline mode.** A `single` / `timeline` switch in the top bar (or `t`) — timeline stacks every artifact of the selected session in one scroll instead of showing one per screen, oldest first, numbered, each card with its own title, time, and open-in-new-tab. Cards auto-size: the injected helper now reports its content height over `postMessage` (a sandboxed frame can't be measured from outside), clamped to 180–760px. Interactions work from any card and are attributed by the frame they came from, not by what the message claims. The mode persists per browser.
- The status bar counts repos alongside sessions.
- **Light and dark themes.** The canvas follows your system by default and a sun/moon control in the top bar pins a choice, remembered per browser and applied before first paint. Every colour became a semantic token defined once per theme; a test now fails if any rule hardcodes one. Text dimming that used `opacity` became a real `--text-faint` colour — the old approach quietly failed contrast. Both themes pass WCAG AA on every text role.
- **Single mode is edge to edge.** The artifact fills the stage with no padded, bordered, rounded frame of our own around it; cards belong to the timeline, which needs them because it stacks many.
- The view switch is a pair of icons instead of the words `single` / `timeline`.
- **Typography and spacing systematized.** One sans type scale (11/12/13/15) replaced five ad hoc sizes, and mono is now reserved for machine identifiers — repo, worktree, branch, `host:port`, version — instead of also setting counts, tags, and status text. Spacing follows a 4px rhythm. Timestamps are relative (`now`, `3m`, `2h` in the sidebar; `3m ago` where there's room) and refresh themselves, with the absolute time on hover. Fewer hairlines: repo groups separate by space, the status bar by `·`. Both empty states now explain what the canvas is for rather than showing a glyph and a sentence.
- **Geometry cleaned up.** Corner radii were six different values picked ad hoc (4/5/7/8/9/12px); they're now a three-step scale applied by nesting depth (`--r-sm`/`--r-md`/`--r-lg`, plus pills for status), with full-bleed bars left square. The sidebar header and the stage top bar were 51px and 58.5px tall, so their hairlines missed each other — both now use one `--header-h` token and line up. Documented in DESIGN.md.
- Sessions report a `origin` object (`repoKey`, `repo`, `repoKind`, `remote`, `worktree`, `worktreeIsMain`) on `GET /api/sessions` and in the canvas snapshot; callers that don't send one are grouped by their directory as before.

## 0.10.0 — 2026-07-30

**The canvas sidebar is a project → session → artifact tree, and the shell has a status bar.**

- **Artifacts are grouped in a tree**: project → session → artifacts. Every session lists its own artifacts nested beneath it (collapsible), so the whole canvas is visible at once instead of one session's worth at a time. Live sessions start expanded; ended ones start collapsed and stay collapsed once you close them.
- **Status bar** across the bottom of the canvas: connection state, server address, live/total sessions, artifact count, queued replies waiting for the agent, and the running version.
- **Canvas shell refreshed**: a top bar naming the artifact you're viewing with its `project / session · updated` breadcrumb plus reload and open-in-new-tab actions, the artifact framed as a lit panel, and clearer selection/hover states in the sidebar.

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
