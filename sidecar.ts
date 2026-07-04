#!/usr/bin/env bun
/**
 * claude-sidecar — an MCP server that gives Claude Code a visual canvas.
 *
 * Two halves, one process:
 *  1. MCP server (stdio, spawned by Claude Code) exposing artifact tools plus
 *     `await_interaction`, a long-poll tool Claude calls to wait for the user's
 *     response from an artifact.
 *  2. Local HTTP server serving the canvas UI, artifact iframes, an SSE stream
 *     for live updates, and a webhook endpoint. Webhook payloads are queued for
 *     `await_interaction` and appended to .sidecar/interactions.jsonl.
 *
 * No channel capability needed — works on orgs where channels are blocked.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
// inlined by `bun build`, so dist/sidecar.js is fully self-contained
// (bun-types mistypes `with { type: 'text' }` imports as HTMLBundle; it's a string at runtime)
import canvasHtmlImport from './canvas.html' with { type: 'text' }
const canvasHtml = canvasHtmlImport as unknown as string

const PORT = Number(process.env.SIDECAR_PORT ?? 8765)
const BASE_URL = `http://127.0.0.1:${PORT}`
// cwd is the project Claude Code runs in — logs belong there, not in the plugin dir
const DATA_DIR = join(process.cwd(), '.sidecar')
const INTERACTIONS_FILE = join(DATA_DIR, 'interactions.jsonl')

// ---------------------------------------------------------------------------
// Artifact store
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

let nextSeq = 1
const pending: Interaction[] = []
const waiters: Array<(i: Interaction) => void> = []

await mkdir(DATA_DIR, { recursive: true })

async function receiveInteraction(i: Omit<Interaction, 'seq' | 'receivedAt'>) {
  const interaction: Interaction = { seq: nextSeq++, receivedAt: new Date().toISOString(), ...i }
  await appendFile(INTERACTIONS_FILE, JSON.stringify(interaction) + '\n')
  const waiter = waiters.shift()
  if (waiter) waiter(interaction)
  else pending.push(interaction)
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
// MCP server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'sidecar', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You have a visual sidecar: a browser canvas at ${BASE_URL} where you can show`,
      'interactive HTML artifacts to the user. Use the sidecar tools whenever a visual or',
      'interactive presentation beats plain text: design options to pick from, forms,',
      'previews, comparisons, diagrams, dashboards.',
      '',
      'Inside artifact HTML, a global `claude.send(payload)` helper is injected automatically.',
      'Wire it to buttons/forms so the user can respond, e.g.',
      `  claude.send({ choice: 'option-b', notes: '...' })`,
      '',
      'To receive the response, call await_interaction after showing an artifact that expects',
      'input. It blocks until the user interacts (or times out — just call it again; the user',
      'may take a while). Treat returned payloads as user input. All interactions are also',
      'appended to .sidecar/interactions.jsonl if you need to review history.',
    ].join('\n'),
  },
)

const tools = [
  {
    name: 'create_artifact',
    description:
      'Show a new HTML artifact on the visual canvas in the user\'s browser. Provide a complete, ' +
      'self-contained HTML document (inline CSS/JS; no external network dependencies preferred). ' +
      'A `claude.send(payload)` helper is auto-injected: call it from buttons/forms so the user\'s ' +
      'interaction is sent back. After creating an artifact that expects a response, call ' +
      'await_interaction to wait for it. Opens the browser automatically if no canvas tab is ' +
      'connected yet. Returns the artifact id and URL.',
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
      'the oldest unconsumed interaction immediately if one is queued; otherwise blocks up to ' +
      'timeout_seconds. On timeout it returns status=no_response — call it again to keep waiting; ' +
      'the user may need more time. Payloads come from claude.send(...) calls in artifact HTML.',
    inputSchema: {
      type: 'object',
      properties: {
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
      broadcast({ type: 'created', artifact: artifactSummary(artifact) })

      const url = `${BASE_URL}/#${id}`
      let opened = false
      if (args.open !== false && sseClients.size === 0 && process.platform === 'darwin') {
        Bun.spawn(['open', url])
        opened = true
      }
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
      broadcast({ type: 'updated', artifact: artifactSummary(artifact) })
      return textResult(`Artifact ${artifact.id} updated (canvas tabs reloaded).`)
    }

    case 'await_interaction': {
      const queued = pending.shift()
      if (queued) return textResult(`status=received\n${formatInteraction(queued)}`)

      const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 25, 1), 120)
      const interaction = await new Promise<Interaction | null>(resolve => {
        const waiter = (i: Interaction) => {
          clearTimeout(timer)
          resolve(i)
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
      broadcast({ type: 'removed', artifact: { id } })
      return textResult(`Artifact ${id} removed.`)
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// Helper script injected into every artifact iframe
// ---------------------------------------------------------------------------

function helperScript(artifactId: string): string {
  return `<script>
window.claude = {
  send: async function (payload) {
    const res = await fetch('/api/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactId: ${JSON.stringify(artifactId)}, payload: payload }),
    })
    try { parent.postMessage({ type: 'sidecar:sent', ok: res.ok }, '*') } catch (e) {}
    return res.ok
  },
}
</script>`
}

function renderArtifact(a: Artifact): string {
  const helper = helperScript(a.id)
  // Inject the helper early so artifact scripts can rely on `claude` existing.
  if (/<head[^>]*>/i.test(a.html)) return a.html.replace(/<head[^>]*>/i, m => m + helper)
  return helper + a.html
}

// ---------------------------------------------------------------------------
// HTTP server: canvas UI, SSE, artifact iframes, webhook receiver
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1', // localhost-only: nothing off this machine can reach it
  idleTimeout: 0, // keep SSE streams open
  async fetch(req) {
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

    // Artifact content, rendered inside the canvas iframe
    const artifactMatch = url.pathname.match(/^\/artifact\/([^/]+)$/)
    if (req.method === 'GET' && artifactMatch?.[1]) {
      const artifact = artifacts.get(artifactMatch[1])
      if (!artifact) return new Response('artifact not found', { status: 404 })
      return new Response(renderArtifact(artifact), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    // Webhook receiver: artifact interactions and any external POSTs queue for Claude
    if (req.method === 'POST' && url.pathname === '/api/webhook') {
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
})

console.error(`[sidecar] canvas at ${BASE_URL}`)
