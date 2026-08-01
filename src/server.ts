/**
 * The singleton sidecar server: one detached process per machine, shared by
 * every agent session on it.
 *
 * It owns all state that used to live inside each MCP process:
 *   - sessions      one per attached agent (project cwd + label), live or ended
 *   - artifacts     per session, so two sessions never see each other's canvas
 *   - interactions  per session queue + waiters, routed by artifact ownership
 *
 * It serves the canvas UI (all sessions in one page), the sandboxed artifact
 * iframes, an SSE stream of session/artifact events, and the token-guarded API
 * that MCP clients and external webhook callers use.
 *
 * Machine-wide state:  ~/.agent-sidecar/{server.json,state.json,server.log}
 * Per-project state:   <cwd>/.sidecar/{session.json,interactions.jsonl}
 */
import { appendFile, mkdir, rename, stat, truncate, writeFile } from 'node:fs/promises'
import { openSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  PREFERRED_PORT,
  PROTOCOL,
  SERVER_FILE,
  SERVER_LOG,
  SIDECAR_HOME,
  STATE_FILE,
  VERSION,
  compareVersions,
  isServerAlive,
  originFromCwd,
  probeServer,
  readServerInfo,
  type ArtifactSummary,
  type Interaction,
  type SessionOrigin,
} from './shared.ts'
// inlined by `bun build`, so dist/sidecar.js is fully self-contained
// (bun-types mistypes `with { type: 'text' }` imports as HTMLBundle; it's a string at runtime)
import canvasTemplateImport from './canvas.html' with { type: 'text' }
const canvasTemplate = canvasTemplateImport as unknown as string

const MAX_LOG_BYTES = 5_000_000
const MAX_SERVER_LOG_BYTES = 2_000_000
/** Ended sessions stay on the canvas for review; keep the newest N. */
const MAX_ENDED_SESSIONS = 20
/** Exit once nothing has needed us for this long. 0 disables. */
const IDLE_EXIT_MS = Number(process.env.SIDECAR_IDLE_EXIT_MS ?? 30 * 60_000)
const PORT_SCAN_RANGE = 10

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Artifact extends ArtifactSummary {
  html: string
}

interface Waiter {
  artifactId?: string
  resolve: (i: Interaction | null) => void
}

interface Session {
  id: string
  cwd: string
  project: string
  /** Repo + worktree this session works in — the two levels above it in the canvas tree. */
  origin: SessionOrigin
  /** Git branch when we can read one, else "session" — what the UI labels it with. */
  label: string
  /**
   * What the *client* half of this session is running. It can legitimately differ
   * from the server's own version — each harness pins its own — so the UI shows
   * both rather than implying one number describes everything.
   */
  version: string | null
  protocol: number | null
  /** Path this client was launched from; how the server finds newer code to restart into. */
  entry: string | null
  pid: number | null
  startedAt: number
  lastSeenAt: number
  endedAt: number | null
  nextArtifactNum: number
  nextSeq: number
  artifacts: Map<string, Artifact>
  pending: Interaction[]
  // transient: not persisted
  waiters: Waiter[]
  attachments: Set<object>
}

const sessions = new Map<string, Session>()
/** artifact id -> session id. Artifact ids are globally unique so /artifact/:id and
 *  interaction routing don't need a session hint. */
const artifactIndex = new Map<string, string>()
let nextSessionNum = 1
/** Which session the canvas is looking at — where unaddressed webhooks land. */
let activeSessionId: string | null = null

function sessionSummary(s: Session) {
  return {
    id: s.id,
    cwd: s.cwd,
    project: s.project,
    origin: s.origin,
    label: s.label,
    version: s.version,
    protocol: s.protocol,
    // endedAt is the durable fact; attachments only disambiguate overlapping reconnects
    live: s.endedAt === null,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    queued: s.pending.length,
    artifacts: [...s.artifacts.values()]
      .map(artifactSummary)
      .sort((a, b) => a.createdAt - b.createdAt),
  }
}

function artifactSummary(a: Artifact): ArtifactSummary {
  return { id: a.id, title: a.title, createdAt: a.createdAt, updatedAt: a.updatedAt }
}

// ---------------------------------------------------------------------------
// Persistence (canvas contents survive a server restart or a reboot)
// ---------------------------------------------------------------------------

async function loadState() {
  let saved: any
  try {
    saved = await Bun.file(STATE_FILE).json()
  } catch {
    return // first run
  }
  const now = Date.now()
  for (const s of saved.sessions ?? []) {
    const session: Session = {
      id: s.id,
      cwd: s.cwd,
      project: s.project ?? basename(s.cwd ?? ''),
      // state written by an older server has no origin: derive one from the cwd
      origin: s.origin ?? originFromCwd(s.cwd ?? ''),
      label: s.label ?? 'session',
      version: s.version ?? null,
      protocol: s.protocol ?? null,
      entry: s.entry ?? null,
      pid: s.pid ?? null,
      startedAt: s.startedAt ?? now,
      lastSeenAt: s.lastSeenAt ?? now,
      // nothing is attached to a freshly started server; a client that is still
      // alive re-attaches within seconds and flips this back to live
      endedAt: s.endedAt ?? now,
      nextArtifactNum: s.nextArtifactNum ?? 1,
      nextSeq: s.nextSeq ?? 1,
      artifacts: new Map((s.artifacts ?? []).map((a: Artifact) => [a.id, a])),
      pending: s.pending ?? [],
      waiters: [],
      attachments: new Set(),
    }
    if (session.artifacts.size === 0 && session.pending.length === 0) continue
    sessions.set(session.id, session)
    for (const id of session.artifacts.keys()) artifactIndex.set(id, session.id)
  }
  nextSessionNum = saved.nextSessionNum ?? sessions.size + 1
  pruneEndedSessions()
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistInFlight = false

/** Debounced so a burst of artifact updates writes once. */
function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistState()
  }, 250)
}

async function persistState() {
  if (persistInFlight) return schedulePersist()
  persistInFlight = true
  try {
    const payload = {
      version: VERSION,
      nextSessionNum,
      sessions: [...sessions.values()].map(s => ({
        id: s.id,
        cwd: s.cwd,
        project: s.project,
        origin: s.origin,
        label: s.label,
        version: s.version,
        protocol: s.protocol,
        entry: s.entry,
        pid: s.pid,
        startedAt: s.startedAt,
        lastSeenAt: s.lastSeenAt,
        endedAt: s.endedAt,
        nextArtifactNum: s.nextArtifactNum,
        nextSeq: s.nextSeq,
        artifacts: [...s.artifacts.values()],
        pending: s.pending,
      })),
    }
    const tmp = STATE_FILE + '.tmp'
    await writeFile(tmp, JSON.stringify(payload))
    await rename(tmp, STATE_FILE) // atomic: a reader never sees a half-written canvas
  } catch (err) {
    console.error('[sidecar] could not persist state:', err)
  } finally {
    persistInFlight = false
  }
}

function pruneEndedSessions() {
  const ended = [...sessions.values()]
    .filter(s => s.endedAt !== null && s.attachments.size === 0)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  for (const s of ended.slice(MAX_ENDED_SESSIONS)) forgetSession(s.id)
}

function forgetSession(id: string) {
  const s = sessions.get(id)
  if (!s) return
  for (const artifactId of s.artifacts.keys()) artifactIndex.delete(artifactId)
  sessions.delete(id)
  if (activeSessionId === id) activeSessionId = null
  broadcast({ type: 'session_removed', id })
  schedulePersist()
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function registerSession(input: {
  resume?: string
  cwd: string
  label?: string
  pid?: number
  origin?: SessionOrigin
  version?: string
  protocol?: number
  entry?: string
}): Session {
  // a caller that doesn't know its repo (external POST, older client) still groups
  // sensibly: its own directory becomes its group
  const origin = input.origin ?? originFromCwd(input.cwd)
  const existing = input.resume ? sessions.get(input.resume) : undefined
  if (existing) {
    // a client reconnecting across a server restart keeps its id and its canvas
    existing.cwd = input.cwd || existing.cwd
    existing.origin = input.origin ?? existing.origin
    existing.label = input.label || existing.label
    existing.pid = input.pid ?? existing.pid
    // a client that reconnected after upgrading is now running different code
    existing.version = input.version ?? existing.version
    existing.protocol = input.protocol ?? existing.protocol
    existing.entry = input.entry ?? existing.entry
    existing.lastSeenAt = Date.now()
    return existing
  }
  const now = Date.now()
  // an unknown resume id still gets honored: the client keeps the id its
  // instruction text already told Claude about
  const id = input.resume ?? `s${nextSessionNum++}-${randomBytes(2).toString('hex')}`
  const session: Session = {
    id,
    cwd: input.cwd,
    project: basename(input.cwd) || input.cwd,
    origin,
    label: input.label || 'session',
    version: input.version ?? null,
    protocol: input.protocol ?? null,
    entry: input.entry ?? null,
    pid: input.pid ?? null,
    startedAt: now,
    lastSeenAt: now,
    endedAt: null,
    nextArtifactNum: 1,
    nextSeq: 1,
    artifacts: new Map(),
    pending: [],
    waiters: [],
    attachments: new Set(),
  }
  sessions.set(id, session)
  schedulePersist()
  return session
}

/**
 * Validates an origin off the wire. Anything malformed is dropped rather than
 * half-trusted, so the tree can never be grouped by a partial identity.
 */
function parseOrigin(raw: unknown): SessionOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.repoKey !== 'string' || !o.repoKey) return undefined
  if (typeof o.repo !== 'string' || !o.repo) return undefined
  if (typeof o.worktree !== 'string' || !o.worktree) return undefined
  return {
    repoKey: o.repoKey,
    repo: o.repo,
    repoKind: o.repoKind === 'git' ? 'git' : 'dir',
    remote: typeof o.remote === 'string' && o.remote ? o.remote : undefined,
    worktree: o.worktree,
    worktreeIsMain: o.worktreeIsMain !== false,
  }
}

function markAttached(s: Session, handle: object) {
  s.attachments.add(handle)
  s.endedAt = null
  s.lastSeenAt = Date.now()
  noteActivity()
  broadcast({ type: 'session', session: sessionSummary(s) })
  schedulePersist()
}

function markDetached(s: Session, handle: object) {
  s.attachments.delete(handle)
  if (s.attachments.size > 0) return // a reconnect overlapped the old stream
  s.endedAt = Date.now()
  s.lastSeenAt = s.endedAt
  // nobody is listening for these any more
  for (const w of s.waiters.splice(0)) w.resolve(null)
  // an ended session with nothing to show is just clutter
  if (s.artifacts.size === 0 && s.pending.length === 0) {
    forgetSession(s.id)
    return
  }
  broadcast({ type: 'session', session: sessionSummary(s) })
  pruneEndedSessions()
  schedulePersist()
}

/**
 * Session lookup for reads (wait/drain). A named session must match exactly —
 * falling back would leak one session's interactions into another's watcher.
 */
function readSession(param: string | null): Session | undefined {
  return param ? sessions.get(param) : routeSession()
}

/** Where an unaddressed interaction should land. */
function routeSession(explicitId?: string | null, artifactId?: string): Session | undefined {
  if (artifactId) {
    const owner = artifactIndex.get(artifactId)
    if (owner) return sessions.get(owner) // artifact ownership is ground truth
  }
  if (explicitId) {
    const named = sessions.get(explicitId)
    if (named) return named
  }
  if (activeSessionId) {
    const active = sessions.get(activeSessionId)
    if (active?.attachments.size) return active // what the user is looking at
  }
  const live = [...sessions.values()]
    .filter(s => s.attachments.size > 0)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  return live[0] ?? [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function newArtifactId(s: Session): string {
  for (;;) {
    const id = `a${s.nextArtifactNum++}-${Math.random().toString(36).slice(2, 7)}`
    if (!artifactIndex.has(id)) return id // ids are machine-wide, so check before use
  }
}

function createArtifact(s: Session, title: string, html: string): Artifact {
  const now = Date.now()
  const artifact: Artifact = { id: newArtifactId(s), title, html, createdAt: now, updatedAt: now }
  s.artifacts.set(artifact.id, artifact)
  artifactIndex.set(artifact.id, s.id)
  schedulePersist()
  broadcast({ type: 'created', sessionId: s.id, artifact: artifactSummary(artifact) })
  return artifact
}

/**
 * Helper script injected into every artifact iframe. The iframe is sandboxed
 * (opaque origin, no direct fetch to the server), so sends go over postMessage
 * to the canvas shell, which holds the token and forwards to /api/webhook.
 *
 * It also reports its own content height: the shell can't measure a cross-origin
 * iframe, so timeline cards size themselves from these messages.
 */
function helperScript(artifactId: string): string {
  return `<script>
(function () {
  var seq = 0, sends = {}, lastPayload = null, lastTime = 0
  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (d && d.type === 'sidecar:sent' && sends[d.id]) { sends[d.id](!!d.ok); delete sends[d.id] }
  })

  var lastHeight = 0, pending = null
  /**
   * Content height, measured from the body's own box plus its margins.
   * scrollHeight is no good on its own: it never reports less than the frame's
   * viewport, so a short artifact could never shrink its card back down.
   */
  function measure() {
    var doc = document.documentElement, body = document.body
    if (body) {
      var cs = getComputedStyle(body)
      var margins = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
      var box = Math.ceil(body.getBoundingClientRect().height + margins)
      // a body pinned to the viewport (height:100%) measures the frame, not the
      // content — fall through to scrollHeight, which at least never clips
      if (box > 0 && Math.abs(box - window.innerHeight) > 2) return box
    }
    return Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0)
  }
  function report() {
    pending = null
    var h = measure()
    // ignore jitter: a card that resizes on every subpixel change flickers
    if (!h || Math.abs(h - lastHeight) < 8) return
    lastHeight = h
    parent.postMessage({ type: 'sidecar:height', artifactId: ${JSON.stringify(artifactId)}, height: h }, '*')
  }
  function schedule() { if (!pending) pending = setTimeout(report, 60) }
  if (document.readyState === 'complete') schedule()
  window.addEventListener('load', schedule)
  // fonts and late layout land after load; a couple of follow-ups settle it
  setTimeout(schedule, 250)
  setTimeout(schedule, 900)
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(schedule)
    if (document.documentElement) ro.observe(document.documentElement)
    document.addEventListener('DOMContentLoaded', function () { if (document.body) ro.observe(document.body) })
  }

  window.claude = {
    send: function (payload) {
      var json = JSON.stringify(payload === undefined ? null : payload)
      var now = Date.now()
      // debounce accidental double-clicks: identical payload within 1.5s is dropped
      if (json === lastPayload && now - lastTime < 1500) return Promise.resolve(false)
      lastPayload = json; lastTime = now
      var id = ++seq
      return new Promise(function (resolve) {
        sends[id] = resolve
        parent.postMessage({ type: 'sidecar:send', id: id, artifactId: ${JSON.stringify(artifactId)}, payload: payload }, '*')
        setTimeout(function () { if (sends[id]) { delete sends[id]; resolve(false) } }, 5000)
      })
    },
  }
})()
</script>`
}

function renderArtifact(a: Artifact): string {
  const helper = helperScript(a.id)
  // Inject the helper early so artifact scripts can rely on `claude` existing.
  if (/<head[^>]*>/i.test(a.html)) return a.html.replace(/<head[^>]*>/i, m => m + helper)
  return helper + a.html
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

function matches(i: Interaction, artifactId?: string): boolean {
  return artifactId === undefined || i.artifactId === artifactId
}

async function receiveInteraction(
  s: Session,
  i: Pick<Interaction, 'kind' | 'payload'> & Partial<Pick<Interaction, 'artifactId' | 'artifactTitle'>>,
) {
  const interaction: Interaction = {
    seq: s.nextSeq++,
    receivedAt: new Date().toISOString(),
    sessionId: s.id,
    ...i,
  }
  noteActivity()
  await appendInteractionLog(s, interaction)

  const idx = s.waiters.findIndex(w => matches(interaction, w.artifactId))
  if (idx >= 0) {
    const [waiter] = s.waiters.splice(idx, 1)
    waiter!.resolve(interaction)
  } else {
    s.pending.push(interaction)
    schedulePersist()
    broadcast({ type: 'session', session: sessionSummary(s) })
  }
}

/** Append-only log in the session's own project, rotated at 5MB. */
async function appendInteractionLog(s: Session, interaction: Interaction) {
  const dir = join(s.cwd, '.sidecar')
  const file = join(dir, 'interactions.jsonl')
  try {
    await mkdir(dir, { recursive: true })
    try {
      const stats = await stat(file)
      if (stats.size > MAX_LOG_BYTES) await rename(file, file + '.old')
    } catch {
      // log doesn't exist yet
    }
    await appendFile(file, JSON.stringify(interaction) + '\n')
  } catch (err) {
    // the project dir can be gone (worktree removed) — never fail the send over it
    console.error(`[sidecar] could not log interaction for ${s.id}:`, err)
  }
}

function takeQueued(s: Session, artifactId?: string): Interaction | null {
  const idx = s.pending.findIndex(i => matches(i, artifactId))
  if (idx < 0) return null
  const [queued] = s.pending.splice(idx, 1)
  schedulePersist()
  broadcast({ type: 'session', session: sessionSummary(s) })
  return queued!
}

/** Resolves with the next matching interaction, or null on timeout/abort/session end. */
function waitForInteraction(
  s: Session,
  artifactId: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Interaction | null> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const waiter: Waiter = {
      artifactId,
      resolve: i => {
        cleanup()
        resolve(i)
      },
    }
    const giveUp = () => {
      const idx = s.waiters.indexOf(waiter)
      if (idx >= 0) s.waiters.splice(idx, 1)
      cleanup()
      resolve(null)
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', giveUp)
    }
    if (timeoutMs > 0) timer = setTimeout(giveUp, timeoutMs)
    signal?.addEventListener('abort', giveUp)
    s.waiters.push(waiter)
  })
}

// ---------------------------------------------------------------------------
// Canvas SSE
// ---------------------------------------------------------------------------

const canvasClients = new Set<(chunk: string) => void>()

function broadcast(event: Record<string, unknown>) {
  const chunk = `data: ${JSON.stringify(event)}\n\n`
  for (const emit of canvasClients) emit(chunk)
}

function snapshot() {
  return {
    type: 'snapshot',
    server: {
      pid: process.pid,
      port: PORT,
      startedAt: STARTED_AT,
      version: VERSION,
      protocol: PROTOCOL,
    },
    activeSessionId,
    sessions: [...sessions.values()]
      .map(sessionSummary)
      .sort((a, b) => a.startedAt - b.startedAt),
  }
}

// ---------------------------------------------------------------------------
// Idle shutdown — a detached process should not outlive its usefulness
// ---------------------------------------------------------------------------

let idleSince: number | null = Date.now()

function noteActivity() {
  idleSince = null
}

function isIdle(): boolean {
  if (canvasClients.size > 0) return false
  return ![...sessions.values()].some(s => s.attachments.size > 0)
}

function startIdleWatch() {
  if (IDLE_EXIT_MS <= 0) return
  setInterval(() => {
    if (!isIdle()) {
      idleSince = null
      return
    }
    idleSince ??= Date.now()
    if (Date.now() - idleSince >= IDLE_EXIT_MS) {
      console.error('[sidecar] idle with no sessions or canvas tabs — exiting')
      void shutdown(0)
    }
  }, 60_000).unref()
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let TOKEN = ''
let PORT = 0
let BASE_URL = ''
const STARTED_AT = new Date().toISOString()
let canvasHtml = ''

function unauthorized() {
  return new Response('missing or invalid token (see ~/.agent-sidecar/server.json)', { status: 403 })
}

function sseResponse(stream: ReadableStream) {
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  if (req.method === 'GET' && path === '/') {
    return new Response(canvasHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  if (req.method === 'GET' && path === '/health') {
    const all = [...sessions.values()]
    return Response.json({
      ok: true,
      server: 'agent-sidecar',
      version: VERSION,
      protocol: PROTOCOL,
      pid: process.pid,
      port: PORT,
      startedAt: STARTED_AT,
      // lets a newly starting client decide whether replacing us would be seen
      idle: isIdle(),
      sessions: { live: all.filter(s => s.endedAt === null).length, total: all.length },
      artifacts: artifactIndex.size,
      canvasTabs: canvasClients.size,
      queuedInteractions: all.reduce((n, s) => n + s.pending.length, 0),
    })
  }

  // Canvas tabs subscribe here for live session + artifact events
  if (req.method === 'GET' && path === '/events') {
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(`data: ${JSON.stringify(snapshot())}\n\n`)
        const emit = (chunk: string) => {
          try {
            ctrl.enqueue(chunk)
          } catch {
            canvasClients.delete(emit)
          }
        }
        canvasClients.add(emit)
        noteActivity()
        req.signal.addEventListener('abort', () => canvasClients.delete(emit))
      },
    })
    return sseResponse(stream)
  }

  // Artifact content, rendered inside the sandboxed canvas iframe
  const artifactMatch = path.match(/^\/artifact\/([^/]+)$/)
  if (req.method === 'GET' && artifactMatch?.[1]) {
    const id = decodeURIComponent(artifactMatch[1])
    const session = sessions.get(artifactIndex.get(id) ?? '')
    const artifact = session?.artifacts.get(id)
    if (!artifact) return new Response('artifact not found', { status: 404 })
    return new Response(renderArtifact(artifact), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  // Everything below is the private API.
  const authorized =
    (req.headers.get('x-sidecar-token') ??
      url.searchParams.get('token') ??
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      '') === TOKEN
  if (!authorized) return unauthorized()

  // --- session lifecycle ----------------------------------------------------

  if (req.method === 'POST' && path === '/api/sessions') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : process.cwd()
    const session = registerSession({
      resume: typeof body.resume === 'string' ? body.resume : undefined,
      cwd,
      label: typeof body.label === 'string' ? body.label : undefined,
      pid: typeof body.pid === 'number' ? body.pid : undefined,
      origin: parseOrigin(body.origin),
      version: typeof body.version === 'string' ? body.version : undefined,
      protocol: typeof body.protocol === 'number' ? body.protocol : undefined,
      entry: typeof body.entry === 'string' ? body.entry : undefined,
    })
    broadcast({ type: 'session', session: sessionSummary(session) })
    return Response.json({
      sessionId: session.id,
      url: BASE_URL,
      version: VERSION,
      protocol: PROTOCOL,
    })
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/)
  if (sessionMatch) {
    const session = sessions.get(sessionMatch[1]!)
    if (!session) return new Response('unknown session', { status: 404 })
    const sub = sessionMatch[2] ?? ''

    // Liveness stream: while it is open the session is live. The MCP process
    // dying closes the socket, which is how we learn the session ended.
    if (req.method === 'GET' && sub === '/attach') {
      const handle = {}
      const stream = new ReadableStream({
        start(ctrl) {
          markAttached(session, handle)
          ctrl.enqueue(`data: ${JSON.stringify({ type: 'attached', sessionId: session.id })}\n\n`)
          const ping = setInterval(() => {
            try {
              ctrl.enqueue(': ping\n\n')
            } catch {
              clearInterval(ping)
            }
          }, 25_000)
          req.signal.addEventListener('abort', () => {
            clearInterval(ping)
            markDetached(session, handle)
          })
        },
      })
      return sseResponse(stream)
    }

    // Forget a session (canvas "dismiss" on an ended one)
    if (req.method === 'DELETE' && sub === '') {
      forgetSession(session.id)
      return Response.json({ ok: true })
    }

    if (req.method === 'GET' && sub === '/artifacts') {
      return Response.json({
        artifacts: [...session.artifacts.values()]
          .map(artifactSummary)
          .sort((a, b) => a.createdAt - b.createdAt),
      })
    }

    if (req.method === 'POST' && sub === '/artifacts') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      session.lastSeenAt = Date.now()
      const artifact = createArtifact(
        session,
        String(body.title ?? 'Untitled'),
        String(body.html ?? ''),
      )
      const artifactUrl = `${BASE_URL}/#${artifact.id}`
      const opened =
        body.open !== false && canvasClients.size === 0 ? openBrowser(artifactUrl) : false
      return Response.json({
        id: artifact.id,
        url: artifactUrl,
        opened,
        canvasTabs: canvasClients.size,
      })
    }

    const artifactSub = sub.match(/^\/artifacts\/([^/]+)$/)
    if (artifactSub?.[1]) {
      const artifact = session.artifacts.get(decodeURIComponent(artifactSub[1]))
      if (!artifact) return new Response('unknown artifact', { status: 404 })

      if (req.method === 'PATCH') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (typeof body.html === 'string') artifact.html = body.html
        if (typeof body.title === 'string') artifact.title = body.title
        artifact.updatedAt = Date.now()
        session.lastSeenAt = artifact.updatedAt
        schedulePersist()
        broadcast({ type: 'updated', sessionId: session.id, artifact: artifactSummary(artifact) })
        return Response.json({ ok: true, canvasTabs: canvasClients.size })
      }

      if (req.method === 'DELETE') {
        session.artifacts.delete(artifact.id)
        artifactIndex.delete(artifact.id)
        schedulePersist()
        broadcast({ type: 'removed', sessionId: session.id, artifact: { id: artifact.id } })
        return Response.json({ ok: true })
      }
    }

    return new Response('not found', { status: 404 })
  }

  // --- interactions ---------------------------------------------------------

  /**
   * Long-poll for the next interaction: the "background watcher" counterpart to
   * the await_interaction tool. Blocks until one arrives (?timeout=SECS to cap,
   * 0/absent = wait indefinitely), then returns it as JSON. Claude runs this via
   * a background Bash `curl` so it can keep working and get re-invoked on your click.
   */
  if (req.method === 'GET' && path === '/api/wait') {
    // strict when a session is named: a watcher for one session must never be
    // handed another session's interaction
    const session = readSession(url.searchParams.get('session'))
    if (!session) return Response.json({ status: 'no_session' }, { status: 404 })
    const artifactId = url.searchParams.get('artifact_id') ?? undefined

    const queued = takeQueued(session, artifactId)
    if (queued) return Response.json(queued)

    const timeoutSec = Number(url.searchParams.get('timeout')) || 0
    const interaction = await waitForInteraction(session, artifactId, timeoutSec * 1000, req.signal)
    if (!interaction) return Response.json({ status: 'no_response' }, { status: 408 })
    return Response.json(interaction)
  }

  /** Drain everything queued for one session without blocking. */
  if (req.method === 'GET' && path === '/api/drain') {
    const session = readSession(url.searchParams.get('session'))
    if (!session) return Response.json({ status: 'no_session' }, { status: 404 })
    const drained = session.pending.splice(0, session.pending.length)
    if (drained.length) {
      schedulePersist()
      broadcast({ type: 'session', session: sessionSummary(session) })
    }
    return Response.json({ interactions: drained })
  }

  /**
   * Webhook receiver: artifact interactions from the canvas plus any external
   * POST. Routing: the artifact's owning session, else ?session=, else whatever
   * the canvas is looking at, else the most recently active live session.
   */
  if (req.method === 'POST' && path === '/api/webhook') {
    const raw = await req.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
    const artifactId = typeof body.artifactId === 'string' ? body.artifactId : undefined
    const session = routeSession(
      (typeof body.sessionId === 'string' ? body.sessionId : null) ??
        url.searchParams.get('session'),
      artifactId,
    )
    if (!session) return Response.json({ ok: false, error: 'no session to deliver to' }, { status: 404 })

    if (body.kind === 'note') {
      // free-text note typed into the canvas shell composer
      await receiveInteraction(session, { kind: 'note', payload: body.note ?? '' })
    } else if (artifactId) {
      // interaction sent via the injected claude.send() helper
      await receiveInteraction(session, {
        kind: 'interaction',
        artifactId,
        artifactTitle: session.artifacts.get(artifactId)?.title,
        payload: body.payload,
      })
    } else {
      // external POST (CI, scripts, curl) — forward the body as-is
      await receiveInteraction(session, { kind: 'webhook', payload: parsed ?? raw })
    }
    return Response.json({ ok: true, sessionId: session.id })
  }

  // --- canvas + admin -------------------------------------------------------

  /** The canvas tells us which session it is showing, so notes and bare
   *  webhooks land where the user is actually looking. */
  if (req.method === 'POST' && path === '/api/canvas/active') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    activeSessionId = typeof body.sessionId === 'string' ? body.sessionId : null
    noteActivity()
    return Response.json({ ok: true })
  }

  if (req.method === 'GET' && path === '/api/sessions') {
    return Response.json({ sessions: [...sessions.values()].map(sessionSummary) })
  }

  if (req.method === 'POST' && path === '/api/shutdown') {
    setTimeout(() => void shutdown(0), 50) // let the response flush first
    return Response.json({ ok: true, stopping: process.pid })
  }

  /**
   * Hand the canvas over to a newer version. Deliberately manual: restarting is
   * always safe (state persists and clients re-attach within seconds) but it is
   * visible, so the user makes the call rather than a background process.
   */
  if (req.method === 'POST' && path === '/api/restart') {
    const target = successorEntry()
    if (!target) {
      return Response.json(
        { ok: false, reason: `no session is running a version newer than ${VERSION}` },
        { status: 409 },
      )
    }
    setTimeout(() => void shutdown(0, target.entry), 50)
    return Response.json({ ok: true, from: VERSION, to: target.version })
  }

  return new Response('not found', { status: 404 })
}

function openBrowser(url: string): boolean {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

const serveOptions = {
  hostname: '127.0.0.1', // localhost-only: nothing off this machine can reach it
  idleTimeout: 0, // keep SSE streams open
  fetch: handle,
}

/**
 * Bind the singleton port. If a sidecar speaking *our* protocol already holds a
 * port in the scan range we are the loser of a startup race and exit quietly.
 * Anything else on the port — a foreign process, or a sidecar on an incompatible
 * protocol that we are deliberately coexisting with — just pushes us one higher.
 */
async function bindPort() {
  if (PREFERRED_PORT === 0) return Bun.serve({ ...serveOptions, port: 0 }) // tests / ephemeral
  for (let port = PREFERRED_PORT; port <= PREFERRED_PORT + PORT_SCAN_RANGE; port++) {
    try {
      return Bun.serve({ ...serveOptions, port })
    } catch (err) {
      const held = await probeServer(`http://127.0.0.1:${port}`)
      if (held?.protocol === PROTOCOL) {
        console.error(`[sidecar] server already running on :${port} — nothing to do`)
        process.exit(0)
      }
      const who = held ? `sidecar on protocol ${held.protocol}` : 'another process'
      console.error(`[sidecar] port ${port} taken by ${who}, trying ${port + 1}`)
    }
  }
  throw new Error(
    `no free port in ${PREFERRED_PORT}-${PREFERRED_PORT + PORT_SCAN_RANGE} (set SIDECAR_PORT)`,
  )
}

let httpServer: ReturnType<typeof Bun.serve> | null = null

/**
 * The newest client code any session has told us about, if it is ahead of us.
 *
 * A server can't discover a new release by itself — it only ever learns of one
 * when a client registers from a newer entry path. Cross-protocol entries are
 * skipped: handing off to code that can't talk to our clients isn't an upgrade.
 */
function successorEntry(): { entry: string; version: string } | null {
  let best: { entry: string; version: string } | null = null
  for (const s of sessions.values()) {
    if (!s.entry || !s.version) continue
    if (s.protocol !== null && s.protocol !== PROTOCOL) continue
    if (!best || compareVersions(s.version, best.version) > 0) {
      best = { entry: s.entry, version: s.version }
    }
  }
  return best && compareVersions(best.version, VERSION) > 0 ? best : null
}

async function shutdown(code: number, successor?: string) {
  try {
    if (persistTimer) clearTimeout(persistTimer)
    await persistState() // the canvas is restored by whoever comes up next
  } catch {
    // best effort
  }
  markServerStopped()
  // Release the port *before* spawning, or the successor loses the bind race to
  // a process that is about to exit anyway and scans itself onto a stray port.
  httpServer?.stop(true)
  if (successor) {
    try {
      const log = openSync(SERVER_LOG, 'a')
      Bun.spawn([process.execPath, successor, '--serve'], {
        cwd: SIDECAR_HOME,
        env: process.env,
        stdin: 'ignore',
        stdout: log,
        stderr: log,
        detached: true,
      }).unref()
    } catch (err) {
      // clients re-spawn a server on their next tool call, so this is recoverable
      console.error('[sidecar] could not launch successor:', err)
    }
  }
  process.exit(code)
}

/**
 * Mark our discovery file stopped instead of deleting it: the next server reads
 * the token back out, so `/api/wait` URLs Claude was already told about keep
 * working across a restart. Clients probe /health, so a stale file misleads nobody.
 */
function markServerStopped() {
  try {
    const info = JSON.parse(readFileSync(SERVER_FILE, 'utf8'))
    if (info.pid !== process.pid) return // someone else's file
    info.stoppedAt = new Date().toISOString()
    writeFileSync(SERVER_FILE, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // already gone, or unwritable — nothing worth failing over
  }
}

/** Keep the log from growing forever across restarts. */
async function trimServerLog() {
  try {
    const stats = await stat(SERVER_LOG)
    if (stats.size > MAX_SERVER_LOG_BYTES) await truncate(SERVER_LOG, 0)
  } catch {
    // no log yet
  }
}

export async function runServer(): Promise<void> {
  await mkdir(SIDECAR_HOME, { recursive: true })
  await trimServerLog()

  // Reuse the previous token so curl watchers and instruction text that outlived
  // a server restart keep working.
  const previous = await readServerInfo()
  const holder = previous?.url ? await probeServer(previous.url) : null
  if (holder?.protocol === PROTOCOL) {
    console.error(`[sidecar] server already running at ${previous!.url} — nothing to do`)
    return
  }
  TOKEN = previous?.token ?? randomBytes(16).toString('hex')

  await loadState()

  httpServer = await bindPort()
  PORT = httpServer.port! // always set: we only ever bind TCP, never a unix socket
  BASE_URL = `http://127.0.0.1:${PORT}`
  // version is injected too, so the status bar reads right before the SSE snapshot lands
  canvasHtml = canvasTemplate
    .replace('__SIDECAR_TOKEN__', TOKEN)
    .replaceAll('__SIDECAR_VERSION__', VERSION)

  const info = {
    server: 'agent-sidecar' as const,
    version: VERSION,
    protocol: PROTOCOL,
    pid: process.pid,
    port: PORT,
    url: BASE_URL,
    token: TOKEN,
    startedAt: STARTED_AT,
  }
  const tmp = SERVER_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, SERVER_FILE)

  process.on('exit', markServerStopped)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => void shutdown(0))
  }
  startIdleWatch()

  console.error(
    `[sidecar] server ${VERSION} listening on ${BASE_URL} (pid ${process.pid}, ` +
      `${sessions.size} restored session(s))`,
  )
}

/** Used by `--stop`. */
export async function stopServer(): Promise<string> {
  const info = await readServerInfo()
  if (!info || !(await isServerAlive(info.url))) return 'No sidecar server is running.'
  try {
    await fetch(`${info.url}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Sidecar-Token': info.token },
    })
  } catch {
    // the process may die before the response lands — that's the point
  }
  for (let i = 0; i < 50; i++) {
    if (!(await isServerAlive(info.url, 500))) {
      // server.json stays behind on purpose (see markServerStopped)
      return `Stopped sidecar server (pid ${info.pid}).`
    }
    await Bun.sleep(100)
  }
  return `Server at ${info.url} did not stop; kill pid ${info.pid} manually.`
}
