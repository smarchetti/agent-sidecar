import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const SERVER = join(REPO, 'src', 'sidecar.ts')

// Every run gets its own machine-wide home + port so it never touches the
// developer's real server (or a parallel test run).
const HOME = mkdtempSync(join(tmpdir(), 'sidecar-home-'))
const PROJECT_A = mkdtempSync(join(tmpdir(), 'sidecar-a-'))
const PROJECT_B = mkdtempSync(join(tmpdir(), 'sidecar-b-'))
const PORT = String(49_100 + Math.floor(Math.random() * 700))

const ENV = {
  ...process.env,
  SIDECAR_HOME: HOME,
  SIDECAR_PORT: PORT,
  SIDECAR_IDLE_EXIT_MS: '0', // never self-exit mid-test
} as Record<string, string>

interface SessionFile {
  pid: number
  serverPid: number
  port: number
  url: string
  token: string
  sessionId: string
}

interface Health {
  ok: boolean
  server: string
  pid: number
  sessions: { live: number; total: number }
  canvasTabs: number
}

function makeClient(cwd: string) {
  const client = new Client({ name: 'test', version: '0.0.1' })
  const connected = client.connect(
    new StdioClientTransport({ command: 'bun', args: [SERVER], cwd, env: ENV, stderr: 'pipe' }),
  )
  return { client, connected }
}

/** The MCP process writes this after it has registered with the server. */
async function readSessionFile(cwd: string, notSessionId?: string): Promise<SessionFile> {
  for (let i = 0; i < 100; i++) {
    try {
      const s = (await Bun.file(join(cwd, '.sidecar', 'session.json')).json()) as SessionFile
      if (s.sessionId && s.sessionId !== notSessionId) return s
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`session.json never appeared in ${cwd}`)
}

const text = (r: any): string => r.content[0].text
const health = async (): Promise<Health> => (await (await fetch(`${base}/health`)).json()) as Health

async function cli(...args: string[]) {
  const proc = Bun.spawn(['bun', SERVER, ...args], { env: ENV, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

let client: Client
let session: SessionFile
let base: string

/** Post to the webhook endpoint the way an external caller would. */
async function webhook(
  body: unknown,
  opts: { token?: string; raw?: boolean; session?: string } = {},
) {
  const query = opts.session ? `?session=${opts.session}` : ''
  return fetch(`${base}/api/webhook${query}`, {
    method: 'POST',
    headers: {
      ...(opts.raw ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.token === undefined ? {} : { 'X-Sidecar-Token': opts.token }),
    },
    body: opts.raw ? String(body) : JSON.stringify(body),
  })
}

/** Interactions the main session sends to itself, addressed explicitly. */
const mine = (body: Record<string, unknown>) =>
  webhook(body, { token: session.token, session: session.sessionId })

beforeAll(async () => {
  const c = makeClient(PROJECT_A)
  client = c.client
  await c.connected
  session = await readSessionFile(PROJECT_A)
  base = session.url
})

afterAll(async () => {
  await client.close().catch(() => {})
  await cli('--stop')
})

describe('mcp surface', () => {
  test('registers the six tools and no channel capability', async () => {
    const caps = client.getServerCapabilities()
    expect(caps?.experimental?.['claude/channel']).toBeUndefined()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'await_interaction',
      'create_artifact',
      'get_interactions',
      'list_artifacts',
      'remove_artifact',
      'update_artifact',
    ])
  })

  test('instructions name this session and its canvas', () => {
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain(session.sessionId)
    expect(instructions).toContain(base)
    expect(instructions).toContain(`session=${session.sessionId}`)
  })
})

describe('http surface', () => {
  test('project session.json points at the shared server', () => {
    expect(session.port).toBe(Number(PORT))
    expect(session.url).toBe(`http://127.0.0.1:${session.port}`)
    expect(session.token).toMatch(/^[0-9a-f]{32}$/)
    expect(session.sessionId).toMatch(/^s\d+-[0-9a-f]{4}$/)
    expect(session.serverPid).toBeGreaterThan(0)
    expect(session.serverPid).not.toBe(session.pid) // the server is its own process
  })

  test('health reports the server and one live session', async () => {
    const h = await health()
    expect(h.ok).toBe(true)
    expect(h.server).toBe('agent-sidecar')
    expect(h.pid).toBe(session.serverPid)
    expect(h.sessions.live).toBe(1)
  })

  test('canvas page is served with the server token injected', async () => {
    const canvas = await (await fetch(base)).text()
    expect(canvas).toContain('agent-sidecar')
    expect(canvas).toContain(session.token)
    expect(canvas).toContain('sandbox="allow-scripts')
  })

  test('canvas status bar carries the real version, not the placeholder', async () => {
    const canvas = await (await fetch(base)).text()
    const { version } = (await (await fetch(`${base}/health`)).json()) as { version: string }
    expect(canvas).not.toContain('__SIDECAR_VERSION__')
    expect(canvas).toContain(`v${version}`)
    expect(canvas).toContain('id="statusbar"')
  })
})

describe('artifact lifecycle', () => {
  let id: string

  test('create_artifact returns id and url', async () => {
    const created = await client.callTool({
      name: 'create_artifact',
      arguments: {
        title: 'Test choice',
        html: '<!doctype html><html><head></head><body><button onclick="claude.send({choice:\'a\'})">A</button></body></html>',
        open: false,
      },
    })
    const m = text(created).match(/id=(\S+) url=/)
    expect(m).not.toBeNull()
    id = m![1]!
  })

  test('artifact is served with the postMessage helper injected after <head>', async () => {
    const html = await (await fetch(`${base}/artifact/${id}`)).text()
    expect(html).toContain('window.claude')
    expect(html).toContain('sidecar:send')
    expect(html.indexOf('window.claude')).toBeGreaterThan(html.indexOf('<head>'))
  })

  test('update_artifact replaces html (helper prepended when no <head>)', async () => {
    const updated = await client.callTool({
      name: 'update_artifact',
      arguments: { id, html: '<html><body>v2</body></html>' },
    })
    expect(text(updated)).toContain('updated')
    const v2 = await (await fetch(`${base}/artifact/${id}`)).text()
    expect(v2.startsWith('<script>')).toBe(true)
    expect(v2).toContain('v2')
  })

  test('list_artifacts shows it', async () => {
    const listed = await client.callTool({ name: 'list_artifacts', arguments: {} })
    expect(text(listed)).toContain(id)
  })

  test('update_artifact on an unknown id is reported, not thrown', async () => {
    const missed = await client.callTool({
      name: 'update_artifact',
      arguments: { id: 'nope-1', html: '<p>x</p>' },
    })
    expect(text(missed)).toContain('No artifact with id nope-1')
  })

  test('remove_artifact removes and 404s', async () => {
    const removed = await client.callTool({ name: 'remove_artifact', arguments: { id } })
    expect(text(removed)).toContain('removed')
    const gone = await fetch(`${base}/artifact/${id}`)
    expect(gone.status).toBe(404)
  })
})

describe('webhook auth', () => {
  test('POST without token is rejected and not queued', async () => {
    const res = await webhook({ artifactId: 'x', payload: { sneaky: true } })
    expect(res.status).toBe(403)
    const drained = await client.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drained)).toContain('No queued')
  })

  test('POST with wrong token is rejected', async () => {
    const res = await webhook({ payload: 1 }, { token: 'f'.repeat(32) })
    expect(res.status).toBe(403)
  })

  test('token accepted via query param', async () => {
    const res = await fetch(
      `${base}/api/webhook?token=${session.token}&session=${session.sessionId}`,
      { method: 'POST', body: 'query-param event' },
    )
    expect(res.status).toBe(200)
    const drained = await client.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drained)).toContain('query-param event')
  })
})

describe('await_interaction', () => {
  test('unblocks when an interaction arrives while waiting', async () => {
    setTimeout(() => mine({ artifactId: 'art-1', payload: { choice: 'b' } }), 400)
    const t0 = Date.now()
    const res = await client.callTool({
      name: 'await_interaction',
      arguments: { timeout_seconds: 10 },
    })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(text(res)).toContain('status=received')
    expect(text(res)).toContain('"choice":"b"')
    expect(text(res)).toContain('art-1')
  })

  test('returns a queued interaction immediately', async () => {
    await mine({ artifactId: 'art-1', payload: { n: 1 } })
    await Bun.sleep(100)
    const t0 = Date.now()
    const res = await client.callTool({ name: 'await_interaction', arguments: { timeout_seconds: 10 } })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(text(res)).toContain('"n":1')
  })

  test('artifact_id filter skips non-matching interactions and leaves them queued', async () => {
    await mine({ artifactId: 'other-artifact', payload: { stale: true } })
    await Bun.sleep(100)

    const miss = await client.callTool({
      name: 'await_interaction',
      arguments: { artifact_id: 'art-2', timeout_seconds: 1 },
    })
    expect(text(miss)).toContain('status=no_response')

    const hit = await client.callTool({
      name: 'await_interaction',
      arguments: { artifact_id: 'other-artifact', timeout_seconds: 1 },
    })
    expect(text(hit)).toContain('"stale":true')
  })

  test('filtered waiter is woken only by a matching interaction', async () => {
    setTimeout(async () => {
      await mine({ artifactId: 'wrong', payload: { w: 1 } })
      await mine({ artifactId: 'right', payload: { r: 1 } })
    }, 300)
    const res = await client.callTool({
      name: 'await_interaction',
      arguments: { artifact_id: 'right', timeout_seconds: 10 },
    })
    expect(text(res)).toContain('"r":1')
    // the non-matching one is still queued
    const drained = await client.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drained)).toContain('"w":1')
  })

  test('times out with no_response', async () => {
    const t0 = Date.now()
    const res = await client.callTool({ name: 'await_interaction', arguments: { timeout_seconds: 1 } })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950)
    expect(text(res)).toContain('status=no_response')
  })
})

describe('GET /api/wait (background watcher)', () => {
  test('rejects without token', async () => {
    const res = await fetch(`${base}/api/wait?timeout=1`)
    expect(res.status).toBe(403)
  })

  test('returns a queued interaction immediately as JSON', async () => {
    await mine({ artifactId: 'w-art', payload: { pick: 'x' } })
    await Bun.sleep(100)
    const res = await fetch(
      `${base}/api/wait?token=${session.token}&session=${session.sessionId}`,
    )
    expect(res.status).toBe(200)
    const i = (await res.json()) as { kind: string; artifactId: string; payload: { pick: string } }
    expect(i.kind).toBe('interaction')
    expect(i.artifactId).toBe('w-art')
    expect(i.payload.pick).toBe('x')
  })

  test('blocks until an interaction arrives, honoring artifact_id filter', async () => {
    setTimeout(async () => {
      await mine({ artifactId: 'not-me', payload: { n: 1 } })
      await mine({ artifactId: 'me', payload: { n: 2 } })
    }, 300)
    const t0 = Date.now()
    const res = await fetch(
      `${base}/api/wait?token=${session.token}&session=${session.sessionId}&artifact_id=me`,
    )
    const i = (await res.json()) as { artifactId: string; payload: { n: number } }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(i.artifactId).toBe('me')
    expect(i.payload.n).toBe(2)
    // the non-matching interaction is still queued
    const drained = await client.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drained)).toContain('"n":1')
  })

  test('returns 408 when the timeout cap elapses', async () => {
    const t0 = Date.now()
    const res = await fetch(
      `${base}/api/wait?token=${session.token}&session=${session.sessionId}&timeout=1`,
    )
    expect(res.status).toBe(408)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950)
  })

  test('an unknown session id is refused rather than served another session', async () => {
    const res = await fetch(`${base}/api/wait?token=${session.token}&session=s999-dead&timeout=1`)
    expect(res.status).toBe(404)
  })
})

describe('canvas notes', () => {
  test('a note is delivered to an unfiltered wait, attributed to the user', async () => {
    await mine({ kind: 'note', note: 'actually, make it green' })
    await Bun.sleep(100)
    const res = await client.callTool({ name: 'await_interaction', arguments: { timeout_seconds: 5 } })
    expect(text(res)).toContain('status=received')
    expect(text(res)).toContain('typed into the canvas')
    expect(text(res)).toContain('actually, make it green')
  })

  test('notes are skipped by artifact-filtered waits and stay queued', async () => {
    await mine({ kind: 'note', note: 'a stray thought' })
    await Bun.sleep(100)
    const miss = await client.callTool({
      name: 'await_interaction',
      arguments: { artifact_id: 'some-artifact', timeout_seconds: 1 },
    })
    expect(text(miss)).toContain('status=no_response')
    const drained = await client.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drained)).toContain('a stray thought')
  })

  test('canvas shell ships the composer and the project/session artifact tree', async () => {
    const canvas = await (await fetch(base)).text()
    expect(canvas).toContain('note-input')
    expect(canvas).toContain("kind: 'note'")
    expect(canvas).toContain('session-list')
    expect(canvas).toContain('/api/canvas/active')
    // artifacts are nested under their session, which is nested under its project
    expect(canvas).toContain('function groupByProject')
    expect(canvas).toContain('function renderSession')
    expect(canvas).toContain('function renderArtifacts')
  })
})

describe('interaction log', () => {
  test('interactions.jsonl records everything with seq/kind/session', async () => {
    const jsonl = await Bun.file(join(PROJECT_A, '.sidecar', 'interactions.jsonl')).text()
    const lines = jsonl
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    for (const l of lines) {
      expect(l.seq).toBeGreaterThan(0)
      expect(['interaction', 'webhook', 'note']).toContain(l.kind)
      expect(l.receivedAt).toBeString()
      expect(l.sessionId).toBe(session.sessionId)
    }
  })
})

describe('one server, many sessions', () => {
  let other: Client
  let otherSession: SessionFile

  beforeAll(async () => {
    const c = makeClient(PROJECT_B)
    other = c.client
    await c.connected
    otherSession = await readSessionFile(PROJECT_B)
  })

  afterAll(async () => {
    await other.close().catch(() => {})
  })

  test('a second project attaches to the same server process and port', () => {
    expect(otherSession.serverPid).toBe(session.serverPid)
    expect(otherSession.port).toBe(session.port)
    expect(otherSession.token).toBe(session.token)
    expect(otherSession.sessionId).not.toBe(session.sessionId)
  })

  test('health counts both sessions as live', async () => {
    const h = await health()
    expect(h.sessions.live).toBe(2)
  })

  test('each session sees only its own artifacts', async () => {
    const created = await other.callTool({
      name: 'create_artifact',
      arguments: { title: 'B only', html: '<html><body>b</body></html>', open: false },
    })
    const bId = text(created).match(/id=(\S+) url=/)![1]!

    const listedB = await other.callTool({ name: 'list_artifacts', arguments: {} })
    expect(text(listedB)).toContain(bId)

    const listedA = await client.callTool({ name: 'list_artifacts', arguments: {} })
    expect(text(listedA)).not.toContain(bId)
    expect(text(listedA)).toContain('No artifacts on the canvas.')
  })

  test('an artifact interaction is routed to the artifact\'s own session', async () => {
    const created = await other.callTool({
      name: 'create_artifact',
      arguments: { title: 'B choice', html: '<html><body>pick</body></html>', open: false },
    })
    const bId = text(created).match(/id=(\S+) url=/)![1]!

    // no session hint at all: artifact ownership alone must route it
    const res = await webhook({ artifactId: bId, payload: { from: 'b' } }, { token: session.token })
    expect(res.status).toBe(200)

    const drainedB = await other.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drainedB)).toContain('"from":"b"')
    expect(text(drainedB)).toContain('B choice')

    const drainedA = await client.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drainedA)).toContain('No queued interactions.')
  })

  test('each project gets its own interaction log', async () => {
    const jsonl = await Bun.file(join(PROJECT_B, '.sidecar', 'interactions.jsonl')).text()
    const lines = jsonl.trim().split('\n').map(l => JSON.parse(l))
    expect(lines.every(l => l.sessionId === otherSession.sessionId)).toBe(true)
  })

  test('the canvas snapshot lists both sessions with their projects', async () => {
    const res = await fetch(`${base}/events`)
    const reader = res.body!.getReader()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    const snapshot = JSON.parse(chunk.replace(/^data: /, ''))
    expect(snapshot.type).toBe('snapshot')
    const ids = snapshot.sessions.map((s: { id: string }) => s.id)
    expect(ids).toContain(session.sessionId)
    expect(ids).toContain(otherSession.sessionId)
    const b = snapshot.sessions.find((s: { id: string }) => s.id === otherSession.sessionId)
    expect(b.project).toBe(PROJECT_B.split('/').pop())
    expect(b.live).toBe(true)
    expect(b.artifacts.length).toBe(2)
  })

  test('the server outlives a session, keeping its artifacts on the canvas', async () => {
    await other.close()
    for (let i = 0; i < 50 && (await health()).sessions.live > 1; i++) await Bun.sleep(100)

    const h = await health()
    expect(h.ok).toBe(true)
    expect(h.pid).toBe(session.serverPid) // same server, still running
    expect(h.sessions.live).toBe(1)
    expect(h.sessions.total).toBe(2) // the ended session is still there to review

    const sessionsRes = await fetch(`${base}/api/sessions`, {
      headers: { 'X-Sidecar-Token': session.token },
    })
    const { sessions } = (await sessionsRes.json()) as {
      sessions: { id: string; live: boolean; artifacts: unknown[] }[]
    }
    const ended = sessions.find(s => s.id === otherSession.sessionId)!
    expect(ended.live).toBe(false)
    expect(ended.artifacts.length).toBe(2)
  })
})

describe('server restart', () => {
  test('a session reclaims its id and artifacts after the server dies', async () => {
    const created = await client.callTool({
      name: 'create_artifact',
      arguments: { title: 'Survivor', html: '<html><body>keep me</body></html>', open: false },
    })
    const id = text(created).match(/id=(\S+) url=/)![1]!
    await Bun.sleep(400) // let the debounced state write land

    const oldPid = (await health()).pid
    await fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Sidecar-Token': session.token },
    })
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })
      } catch {
        break // down
      }
      await Bun.sleep(100)
    }

    // the next tool call notices, restarts the server and re-registers this session
    const listed = await client.callTool({ name: 'list_artifacts', arguments: {} })
    expect(text(listed)).toContain(id)
    expect(text(listed)).toContain('Survivor')

    // the replacement server reclaims the same port and reuses the token, so
    // instruction text and background watchers from before the crash still work
    const revived = (await Bun.file(join(HOME, 'server.json')).json()) as SessionFile & {
      port: number
    }
    base = `http://127.0.0.1:${revived.port}`
    expect(revived.port).toBe(Number(PORT))
    expect(revived.token).toBe(session.token)
    expect((await health()).pid).not.toBe(oldPid)
  })
})

describe('cli', () => {
  test('--status reports the server and its sessions', async () => {
    const out = await cli('--status')
    expect(out).toContain('running')
    expect(out).toContain(session.sessionId)
  })

  test('--stop shuts the server down and --status says so', async () => {
    const stopped = await cli('--stop')
    expect(stopped).toContain('Stopped sidecar server')
    expect(await cli('--status')).toContain('not running')
  })
})
