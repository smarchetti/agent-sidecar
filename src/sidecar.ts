#!/usr/bin/env bun
/**
 * agent-sidecar — an MCP server that gives Claude Code a visual canvas.
 *
 * Two halves, one process:
 *  1. MCP server (stdio, spawned by Claude Code) exposing artifact tools plus
 *     `await_interaction`, a long-poll tool Claude calls to wait for the user's
 *     response from an artifact.
 *  2. Local HTTP server serving the canvas UI, artifact iframes, an SSE stream
 *     for live updates, and a webhook endpoint. Webhook payloads are queued for
 *     `await_interaction` and appended to .sidecar/interactions.jsonl.
 *
 * Per-session state lives in .sidecar/ under the project cwd:
 *   session.json        — port + auth token for this session (for external callers)
 *   artifacts.json      — canvas contents, restored on restart
 *   interactions.jsonl  — append-only interaction log, rotated at 5MB
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
// inlined by `bun build`, so dist/sidecar.js is fully self-contained
// (bun-types mistypes `with { type: 'text' }` imports as HTMLBundle; it's a string at runtime)
import canvasTemplateImport from './canvas.html' with { type: 'text' }
const canvasTemplate = canvasTemplateImport as unknown as string

// cwd is the project Claude Code runs in — session state belongs there, not in the plugin dir
const DATA_DIR = join(process.cwd(), '.sidecar')
const SESSION_FILE = join(DATA_DIR, 'session.json')
const ARTIFACTS_FILE = join(DATA_DIR, 'artifacts.json')
const INTERACTIONS_FILE = join(DATA_DIR, 'interactions.jsonl')
const MAX_LOG_BYTES = 5_000_000

// Required on every webhook POST. Without it, any webpage the user visits could
// fire cross-site POSTs at localhost and inject text in front of Claude.
const TOKEN = randomBytes(16).toString('hex')

await mkdir(DATA_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Artifact store (persisted so a session restart doesn't empty the canvas)
// ---------------------------------------------------------------------------

interface Artifact {
  id: string
  title: string
  html: string
  createdAt: number
  updatedAt: number
}

const artifacts = new Map<string, Artifact>()
let nextArtifactNum = 1

try {
  const saved = await Bun.file(ARTIFACTS_FILE).json()
  for (const a of saved.artifacts ?? []) artifacts.set(a.id, a)
  nextArtifactNum = saved.nextArtifactNum ?? artifacts.size + 1
} catch {
  // no saved canvas (first run) — start empty
}

async function persistArtifacts() {
  await writeFile(
    ARTIFACTS_FILE,
    JSON.stringify({ nextArtifactNum, artifacts: [...artifacts.values()] }),
  )
}

function newArtifactId(): string {
  return `a${nextArtifactNum++}-${Math.random().toString(36).slice(2, 7)}`
}

// ---------------------------------------------------------------------------
// Interaction queue: webhook payloads waiting for Claude to consume
// ---------------------------------------------------------------------------

interface Interaction {
  seq: number
  receivedAt: string
  kind: 'interaction' | 'webhook'
  artifactId?: string
  artifactTitle?: string
  payload: unknown
}

interface Waiter {
  artifactId?: string
  resolve: (i: Interaction) => void
}

let nextSeq = 1
const pending: Interaction[] = []
const waiters: Waiter[] = []

function matches(i: Interaction, artifactId?: string): boolean {
  return artifactId === undefined || i.artifactId === artifactId
}

async function receiveInteraction(i: Omit<Interaction, 'seq' | 'receivedAt'>) {
  const interaction: Interaction = { seq: nextSeq++, receivedAt: new Date().toISOString(), ...i }

  try {
    const s = await stat(INTERACTIONS_FILE)
    if (s.size > MAX_LOG_BYTES) await rename(INTERACTIONS_FILE, INTERACTIONS_FILE + '.old')
  } catch {
    // log doesn't exist yet
  }
  await appendFile(INTERACTIONS_FILE, JSON.stringify(interaction) + '\n')

  const idx = waiters.findIndex(w => matches(interaction, w.artifactId))
  if (idx >= 0) {
    const [waiter] = waiters.splice(idx, 1)
    waiter!.resolve(interaction)
  } else {
    pending.push(interaction)
  }
}

function formatInteraction(i: Interaction): string {
  const origin =
    i.kind === 'interaction'
      ? `artifact ${i.artifactId}${i.artifactTitle ? ` ("${i.artifactTitle}")` : ''}`
      : 'external webhook'
  return `[${i.receivedAt}] from ${origin}:\n${JSON.stringify(i.payload)}`
}

// ---------------------------------------------------------------------------
// SSE broadcast to canvas pages
// ---------------------------------------------------------------------------

const sseClients = new Set<(chunk: string) => void>()

function broadcast(event: Record<string, unknown>) {
  const chunk = `data: ${JSON.stringify(event)}\n\n`
  for (const emit of sseClients) emit(chunk)
}

function artifactSummary(a: Artifact) {
  return { id: a.id, title: a.title, createdAt: a.createdAt, updatedAt: a.updatedAt }
}

// ---------------------------------------------------------------------------
// Helper script injected into every artifact iframe. The iframe is sandboxed
// (opaque origin, no direct fetch to the server), so sends go over postMessage
// to the canvas shell, which holds the token and forwards to /api/webhook.
// ---------------------------------------------------------------------------

function helperScript(artifactId: string): string {
  return `<script>
(function () {
  var seq = 0, sends = {}, lastPayload = null, lastTime = 0
  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (d && d.type === 'sidecar:sent' && sends[d.id]) { sends[d.id](!!d.ok); delete sends[d.id] }
  })
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
// HTTP server: canvas UI, SSE, artifact iframes, webhook receiver.
// Started before the MCP server so BASE_URL (with the real bound port) can go
// into Claude's instructions.
// ---------------------------------------------------------------------------

const canvasHtml = canvasTemplate.replace('__SIDECAR_TOKEN__', TOKEN)

const serveOptions = {
  hostname: '127.0.0.1', // localhost-only: nothing off this machine can reach it
  idleTimeout: 0, // keep SSE streams open
  async fetch(req: Request) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(canvasHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ok: true,
        artifacts: artifacts.size,
        canvasTabs: sseClients.size,
        queuedInteractions: pending.length,
      })
    }

    // SSE stream: canvas tabs subscribe for live artifact create/update/remove
    if (req.method === 'GET' && url.pathname === '/events') {
      const stream = new ReadableStream({
        start(ctrl) {
          const snapshot = [...artifacts.values()].map(artifactSummary)
          ctrl.enqueue(`data: ${JSON.stringify({ type: 'snapshot', artifacts: snapshot })}\n\n`)
          const emit = (chunk: string) => {
            try {
              ctrl.enqueue(chunk)
            } catch {
              sseClients.delete(emit)
            }
          }
          sseClients.add(emit)
          req.signal.addEventListener('abort', () => sseClients.delete(emit))
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      })
    }

    // Artifact content, rendered inside the sandboxed canvas iframe
    const artifactMatch = url.pathname.match(/^\/artifact\/([^/]+)$/)
    if (req.method === 'GET' && artifactMatch?.[1]) {
      const artifact = artifacts.get(artifactMatch[1])
      if (!artifact) return new Response('artifact not found', { status: 404 })
      return new Response(renderArtifact(artifact), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    const authorized =
      (req.headers.get('x-sidecar-token') ??
        url.searchParams.get('token') ??
        req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        '') === TOKEN

    // Long-poll for the next interaction: the "background watcher" counterpart to the
    // await_interaction tool. Blocks until an interaction arrives (?timeout=SECS to cap,
    // 0/absent = wait indefinitely), then returns it as JSON. Claude runs this via a
    // background Bash `curl` so it can keep working and get re-invoked on your click.
    if (req.method === 'GET' && url.pathname === '/api/wait') {
      if (!authorized) {
        return new Response('missing or invalid token (see .sidecar/session.json)', { status: 403 })
      }
      const artifactId = url.searchParams.get('artifact_id') ?? undefined

      const queuedIdx = pending.findIndex(i => matches(i, artifactId))
      if (queuedIdx >= 0) {
        const [queued] = pending.splice(queuedIdx, 1)
        return Response.json(queued)
      }

      const timeoutSec = Number(url.searchParams.get('timeout')) || 0
      const interaction = await new Promise<Interaction | null>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const waiter: Waiter = {
          artifactId,
          resolve: i => {
            cleanup()
            resolve(i)
          },
        }
        const giveUp = () => {
          const idx = waiters.indexOf(waiter)
          if (idx >= 0) waiters.splice(idx, 1)
          cleanup()
          resolve(null)
        }
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          req.signal.removeEventListener('abort', giveUp)
        }
        if (timeoutSec > 0) timer = setTimeout(giveUp, timeoutSec * 1000)
        req.signal.addEventListener('abort', giveUp)
        waiters.push(waiter)
      })

      if (!interaction) return Response.json({ status: 'no_response' }, { status: 408 })
      return Response.json(interaction)
    }

    // Webhook receiver: artifact interactions and any external POSTs queue for Claude
    if (req.method === 'POST' && url.pathname === '/api/webhook') {
      if (!authorized) {
        return new Response('missing or invalid token (see .sidecar/session.json)', { status: 403 })
      }

      const raw = await req.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = undefined
      }

      if (parsed && typeof parsed === 'object' && 'artifactId' in parsed) {
        // Interaction sent via the injected claude.send() helper
        const artifactId = String((parsed as Record<string, unknown>).artifactId)
        await receiveInteraction({
          kind: 'interaction',
          artifactId,
          artifactTitle: artifacts.get(artifactId)?.title,
          payload: (parsed as Record<string, unknown>).payload,
        })
      } else {
        // External POST (CI, scripts, curl) — forward the body as-is
        await receiveInteraction({ kind: 'webhook', payload: parsed ?? raw })
      }
      return Response.json({ ok: true })
    }

    return new Response('not found', { status: 404 })
  },
}

function startHttp() {
  const preferred = Number(process.env.SIDECAR_PORT ?? 8765)
  try {
    return Bun.serve({ ...serveOptions, port: preferred })
  } catch (err) {
    if (preferred === 0) throw err
    // another session holds the port — take an ephemeral one instead of crashing
    console.error(`[sidecar] port ${preferred} in use, falling back to an ephemeral port`)
    return Bun.serve({ ...serveOptions, port: 0 })
  }
}

const httpServer = startHttp()
const PORT = httpServer.port
const BASE_URL = `http://127.0.0.1:${PORT}`

// Discovery file for this session: external webhook callers read the port and
// token from here. Removed on clean exit if it's still ours.
await writeFile(
  SESSION_FILE,
  JSON.stringify(
    { pid: process.pid, port: PORT, url: BASE_URL, token: TOKEN, startedAt: new Date().toISOString() },
    null,
    2,
  ) + '\n',
)
process.on('exit', () => {
  try {
    if (JSON.parse(readFileSync(SESSION_FILE, 'utf8')).pid === process.pid) unlinkSync(SESSION_FILE)
  } catch {
    // someone else's session file (or already gone) — leave it
  }
})

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
// MCP server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'agent-sidecar', version: '0.7.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You have agent-sidecar, a visual canvas at ${BASE_URL} where you can show`,
      'interactive HTML artifacts to the user. Use the sidecar tools whenever a visual or',
      'interactive presentation beats plain text: design options to pick from, forms,',
      'previews, comparisons, diagrams, dashboards.',
      '',
      'Inside artifact HTML, a global `claude.send(payload)` helper is injected automatically.',
      'Wire it to buttons/forms so the user can respond, e.g.',
      `  claude.send({ choice: 'option-b', notes: '...' })`,
      '',
      'Two ways to receive the response after showing an artifact that expects input',
      '(always pass/append its artifact_id so stale clicks elsewhere are not mistaken for the answer):',
      '- Quick decision expected: call await_interaction. It blocks until the user interacts',
      '  (or times out — just call it again; the user may take a while).',
      '- The user may take minutes, or you have other work to do meanwhile: run a background',
      '  Bash watcher and continue working — you will be re-invoked with the payload when it exits:',
      `    curl -s "${BASE_URL}/api/wait?token=${TOKEN}&artifact_id=ID"  (run_in_background: true)`,
      'Treat returned payloads as user input. All interactions are also appended to',
      '.sidecar/interactions.jsonl if you need to review history.',
      '',
      'Artifacts render in a sandboxed iframe (no network, no storage): keep them fully',
      'self-contained with inline CSS/JS and use claude.send() as the only output channel.',
    ].join('\n'),
  },
)

const tools = [
  {
    name: 'create_artifact',
    description:
      'Show a new HTML artifact on the visual canvas in the user\'s browser. Provide a complete, ' +
      'self-contained HTML document (inline CSS/JS; the iframe is sandboxed, so no external ' +
      'network access or storage). A `claude.send(payload)` helper is auto-injected: call it ' +
      'from buttons/forms so the user\'s interaction is sent back. After creating an artifact ' +
      'that expects a response, call await_interaction with its artifact_id. Opens the browser ' +
      'automatically if no canvas tab is connected yet. Returns the artifact id and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human-readable title shown in the canvas sidebar' },
        html: { type: 'string', description: 'Complete HTML document for the artifact' },
        open: {
          type: 'boolean',
          description: 'Open the canvas in the default browser if no tab is connected (default true)',
        },
      },
      required: ['title', 'html'],
    },
  },
  {
    name: 'update_artifact',
    description:
      'Replace the HTML (and optionally the title) of an existing artifact. Connected canvas tabs ' +
      'reload it live. Use this to iterate on an artifact after user feedback instead of creating ' +
      'a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id returned by create_artifact' },
        html: { type: 'string', description: 'New complete HTML document' },
        title: { type: 'string', description: 'New title (optional)' },
      },
      required: ['id', 'html'],
    },
  },
  {
    name: 'await_interaction',
    description:
      'Wait for the user to interact with an artifact (or for an external webhook POST). Returns ' +
      'the oldest matching unconsumed interaction immediately if one is queued; otherwise blocks ' +
      'up to timeout_seconds. Pass artifact_id to only accept interactions from that artifact ' +
      '(recommended after showing choices, so stale clicks elsewhere are not misread as the ' +
      'answer). On timeout it returns status=no_response — call it again to keep waiting; the ' +
      'user may need more time. If you have other work to do while waiting, use the background ' +
      'GET /api/wait watcher from the server instructions instead of this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: {
          type: 'string',
          description: 'Only accept interactions from this artifact (others stay queued)',
        },
        timeout_seconds: {
          type: 'number',
          description: 'How long to block waiting (default 25, max 120)',
        },
      },
    },
  },
  {
    name: 'get_interactions',
    description:
      'Drain all queued interactions without blocking. Use to check whether the user clicked ' +
      'something while you were doing other work.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_artifacts',
    description: 'List artifacts currently on the canvas (id, title, timestamps).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_artifact',
    description: 'Remove an artifact from the canvas.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Artifact id to remove' } },
      required: ['id'],
    },
  },
]

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  switch (req.params.name) {
    case 'create_artifact': {
      const id = newArtifactId()
      const now = Date.now()
      const artifact: Artifact = {
        id,
        title: String(args.title ?? 'Untitled'),
        html: String(args.html ?? ''),
        createdAt: now,
        updatedAt: now,
      }
      artifacts.set(id, artifact)
      await persistArtifacts()
      broadcast({ type: 'created', artifact: artifactSummary(artifact) })

      const url = `${BASE_URL}/#${id}`
      let opened = false
      if (args.open !== false && sseClients.size === 0) opened = openBrowser(url)
      return textResult(
        `Artifact created: id=${id} url=${url}` +
          (opened ? ' (opened in browser)' : ` (${sseClients.size} canvas tab(s) already connected)`),
      )
    }

    case 'update_artifact': {
      const artifact = artifacts.get(String(args.id))
      if (!artifact) return textResult(`No artifact with id ${args.id}. Use list_artifacts.`)
      artifact.html = String(args.html ?? artifact.html)
      if (typeof args.title === 'string') artifact.title = args.title
      artifact.updatedAt = Date.now()
      await persistArtifacts()
      broadcast({ type: 'updated', artifact: artifactSummary(artifact) })
      return textResult(`Artifact ${artifact.id} updated (canvas tabs reloaded).`)
    }

    case 'await_interaction': {
      const artifactId = typeof args.artifact_id === 'string' ? args.artifact_id : undefined

      const queuedIdx = pending.findIndex(i => matches(i, artifactId))
      if (queuedIdx >= 0) {
        const [queued] = pending.splice(queuedIdx, 1)
        return textResult(`status=received\n${formatInteraction(queued!)}`)
      }

      const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 25, 1), 120)
      const interaction = await new Promise<Interaction | null>(resolve => {
        const waiter: Waiter = {
          artifactId,
          resolve: i => {
            clearTimeout(timer)
            resolve(i)
          },
        }
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter)
          if (idx >= 0) waiters.splice(idx, 1)
          resolve(null)
        }, timeoutSec * 1000)
        waiters.push(waiter)
      })

      if (!interaction) {
        return textResult(
          `status=no_response after ${timeoutSec}s. The user hasn't interacted yet — ` +
            'call await_interaction again to keep waiting.',
        )
      }
      return textResult(`status=received\n${formatInteraction(interaction)}`)
    }

    case 'get_interactions': {
      if (pending.length === 0) return textResult('No queued interactions.')
      const drained = pending.splice(0, pending.length)
      return textResult(drained.map(formatInteraction).join('\n\n'))
    }

    case 'list_artifacts': {
      if (artifacts.size === 0) return textResult('No artifacts on the canvas.')
      const lines = [...artifacts.values()].map(
        a => `${a.id}\t"${a.title}"\tcreated ${new Date(a.createdAt).toISOString()}`,
      )
      return textResult(lines.join('\n'))
    }

    case 'remove_artifact': {
      const id = String(args.id)
      if (!artifacts.delete(id)) return textResult(`No artifact with id ${id}.`)
      await persistArtifacts()
      broadcast({ type: 'removed', artifact: { id } })
      return textResult(`Artifact ${id} removed.`)
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

await mcp.connect(new StdioServerTransport())

console.error(`[sidecar] canvas at ${BASE_URL}`)
