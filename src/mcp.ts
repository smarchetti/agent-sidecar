/**
 * MCP half: the six artifact/interaction tools, backed by the singleton server.
 *
 * This process holds no canvas state. It registers one session on the server and
 * translates tool calls into session-scoped HTTP calls, so several agent sessions
 * — in this project or any other — share one canvas and one browser tab.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { SessionLink, SidecarApiError, type WaitResult } from './client.ts'
import { VERSION, formatInteraction, type ArtifactSummary, type Interaction } from './shared.ts'

/**
 * Discovery file for external webhook callers, kept in the project like before.
 * Two sessions in one project overwrite each other here — the values they'd write
 * are identical apart from sessionId, since the server is shared.
 */
async function writeProjectSessionFile(link: SessionLink) {
  const dir = join(link.cwd, '.sidecar')
  const file = join(dir, 'session.json')
  await mkdir(dir, { recursive: true })
  await writeFile(
    file,
    JSON.stringify(
      {
        pid: process.pid,
        serverPid: link.info.pid,
        port: link.info.port,
        url: link.url,
        token: link.token,
        sessionId: link.sessionId,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  )
  process.on('exit', () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file)
    } catch {
      // another session's file (or already gone) — leave it
    }
  })
}

function instructions(link: SessionLink): string {
  return [
    `You have agent-sidecar, a visual canvas at ${link.url} where you can show`,
    'interactive HTML artifacts to the user. Use the sidecar tools whenever a visual or',
    'interactive presentation beats plain text: design options to pick from, forms,',
    'previews, comparisons, diagrams, dashboards.',
    '',
    `One server serves every agent session on this machine; yours is ${link.sessionId}`,
    `(${link.project}). The canvas lists all sessions and shows one at a time, so your`,
    'artifacts and interactions stay separate from other sessions automatically.',
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
    `    curl -s "${link.url}/api/wait?token=${link.token}&session=${link.sessionId}&artifact_id=ID"  (run_in_background: true)`,
    'Treat returned payloads as user input. The user can also type free-text notes into the',
    'canvas at any time; they arrive through the same tools marked as coming from the user',
    '(notes have no artifact_id, so only unfiltered waits receive them). All interactions are',
    'also appended to .sidecar/interactions.jsonl if you need to review history.',
    '',
    'Artifacts render in a sandboxed iframe (no network, no storage): keep them fully',
    'self-contained with inline CSS/JS and use claude.send() as the only output channel.',
    '',
    'Artifact quality bar: real layout, not a wall of text. Generous padding (32-48px), a',
    'system-ui font stack, 15-16px body text, ONE accent color used sparingly, buttons at',
    'least 40px tall with hover states, and a visible confirmation state after claude.send()',
    'resolves (e.g. highlight the chosen card). Design around the payload you want back.',
  ].join('\n')
}

const tools = [
  {
    name: 'create_artifact',
    description:
      "Show a new HTML artifact on the visual canvas in the user's browser. Provide a complete, " +
      'self-contained HTML document (inline CSS/JS; the iframe is sandboxed, so no external ' +
      'network access or storage). A `claude.send(payload)` helper is auto-injected: call it ' +
      "from buttons/forms so the user's interaction is sent back. After creating an artifact " +
      'that expects a response, call await_interaction with its artifact_id. Opens the browser ' +
      'automatically if no canvas tab is connected yet. Returns the artifact id and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short human-readable title shown in the canvas sidebar',
        },
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

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export async function runMcp(entry: string): Promise<void> {
  const link = await SessionLink.open(entry)
  await writeProjectSessionFile(link)

  const mcp = new Server(
    { name: 'agent-sidecar', version: VERSION },
    { capabilities: { tools: {} }, instructions: instructions(link) },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>

    switch (req.params.name) {
      case 'create_artifact': {
        const created = await link.api<{
          id: string
          url: string
          opened: boolean
          canvasTabs: number
        }>('/api/sessions/{s}/artifacts', {
          method: 'POST',
          body: JSON.stringify({
            title: String(args.title ?? 'Untitled'),
            html: String(args.html ?? ''),
            open: args.open !== false,
          }),
        })
        return textResult(
          `Artifact created: id=${created.id} url=${created.url}` +
            (created.opened
              ? ' (opened in browser)'
              : ` (${created.canvasTabs} canvas tab(s) already connected)`),
        )
      }

      case 'update_artifact': {
        const id = String(args.id)
        try {
          await link.api(`/api/sessions/{s}/artifacts/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              html: args.html === undefined ? undefined : String(args.html),
              title: typeof args.title === 'string' ? args.title : undefined,
            }),
          })
        } catch (err) {
          if (err instanceof SidecarApiError && err.status === 404) {
            return textResult(`No artifact with id ${id}. Use list_artifacts.`)
          }
          throw err
        }
        return textResult(`Artifact ${id} updated (canvas tabs reloaded).`)
      }

      case 'await_interaction': {
        const artifactId = typeof args.artifact_id === 'string' ? args.artifact_id : undefined
        const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 25, 1), 120)
        const query = new URLSearchParams({
          session: link.sessionId,
          timeout: String(timeoutSec),
        })
        if (artifactId) query.set('artifact_id', artifactId)

        const result = await link.api<WaitResult>(`/api/wait?${query}`)
        if (result.status === 'no_response' || !result.kind) {
          return textResult(
            `status=no_response after ${timeoutSec}s. The user hasn't interacted yet — ` +
              'call await_interaction again to keep waiting.',
          )
        }
        return textResult(`status=received\n${formatInteraction(result as Interaction)}`)
      }

      case 'get_interactions': {
        const { interactions } = await link.api<{ interactions: Interaction[] }>(
          `/api/drain?session=${link.sessionId}`,
        )
        if (interactions.length === 0) return textResult('No queued interactions.')
        return textResult(interactions.map(formatInteraction).join('\n\n'))
      }

      case 'list_artifacts': {
        const { artifacts } = await link.api<{ artifacts: ArtifactSummary[] }>(
          '/api/sessions/{s}/artifacts',
        )
        if (artifacts.length === 0) return textResult('No artifacts on the canvas.')
        return textResult(
          artifacts
            .map(a => `${a.id}\t"${a.title}"\tcreated ${new Date(a.createdAt).toISOString()}`)
            .join('\n'),
        )
      }

      case 'remove_artifact': {
        const id = String(args.id)
        try {
          await link.api(`/api/sessions/{s}/artifacts/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          })
        } catch (err) {
          if (err instanceof SidecarApiError && err.status === 404) {
            return textResult(`No artifact with id ${id}.`)
          }
          throw err
        }
        return textResult(`Artifact ${id} removed.`)
      }

      default:
        throw new Error(`unknown tool: ${req.params.name}`)
    }
  })

  await mcp.connect(new StdioServerTransport())

  console.error(
    `[sidecar] session ${link.sessionId} (${link.project}) on canvas ${link.url} ` +
      `(server pid ${link.info.pid})`,
  )
}
