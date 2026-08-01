import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')

/**
 * What actually runs the sidecar under test. The default exercises the working
 * source under bun; SIDECAR_TEST_RUNTIME=node exercises the built bundle under
 * node, which is what ships — the two runtimes have already disagreed about
 * node:http disconnect events, so both legs earn their keep.
 */
const RUNTIME = process.env.SIDECAR_TEST_RUNTIME === 'node' ? 'node' : 'bun'
const SERVER =
  RUNTIME === 'node' ? join(REPO, 'dist', 'sidecar.js') : join(REPO, 'src', 'sidecar.ts')

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

function makeClient(cwd: string, env: Record<string, string> = ENV) {
  const client = new Client({ name: 'test', version: '0.0.1' })
  const connected = client.connect(
    new StdioClientTransport({ command: RUNTIME, args: [SERVER], cwd, env, stderr: 'pipe' }),
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
  return cliIn(ENV, ...args)
}

async function cliIn(env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn([RUNTIME, SERVER, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
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

  test('canvas ships both view modes, with the timeline builder', async () => {
    const canvas = await (await fetch(base)).text()
    expect(canvas).toContain('id="mode-switch"')
    expect(canvas).toContain('data-mode="timeline"')
    expect(canvas).toContain('function renderTimeline')
    expect(canvas).toContain("localStorage.setItem('sidecar:viewMode'")
    // a card must answer for its own artifact, never for one the message names
    expect(canvas).toContain('function artifactOfSource')
  })

  test('canvas ships both themes and applies a saved one before first paint', async () => {
    const canvas = await (await fetch(base)).text()
    expect(canvas).toContain('[data-theme="light"]')
    expect(canvas).toContain('prefers-color-scheme: light')
    expect(canvas).toContain("localStorage.setItem('sidecar:theme'")
    // the pre-paint script has to sit in <head>, above the stylesheet's consumers
    expect(canvas.indexOf("localStorage.getItem('sidecar:theme')")).toBeLessThan(
      canvas.indexOf('<body>'),
    )
    // colours are all tokens, so a rule never hardcodes one theme's value
    const styles = canvas.slice(canvas.indexOf('<style>'), canvas.indexOf('</style>'))
    const literals = styles
      .split('\n')
      .filter(l => /oklch\(|#[0-9a-f]{3,6}\b/i.test(l) && !l.includes('--'))
    expect(literals).toEqual([])
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

  test('the helper reports its own height, so timeline cards can size themselves', async () => {
    const html = await (await fetch(`${base}/artifact/${id}`)).text()
    expect(html).toContain('sidecar:height')
    // measuring the body box is what lets a short artifact shrink its card;
    // scrollHeight alone never reports less than the frame's own viewport
    expect(html).toContain('getBoundingClientRect')
    expect(html).toContain('ResizeObserver')
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
    // artifacts are nested under their session, which is nested under its repo
    expect(canvas).toContain('function buildTree')
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

/**
 * Two checkouts of one repo have to land under one repo in the canvas tree — that's
 * the whole point of keying on the main worktree's git dir rather than the cwd name.
 */
describe('repo and worktree grouping', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'sidecar-git-'))
  const MAIN = join(ROOT, 'widgets-main')
  const LINKED = join(ROOT, 'widgets-feat-tree')
  let mainSession: SessionFile
  let linkedSession: SessionFile
  let mainClient: Client
  let linkedClient: Client

  beforeAll(async () => {
    const git = (cwd: string, args: string[]) =>
      Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' }).exited

    mkdirSync(MAIN, { recursive: true })
    await git(MAIN, ['init', '-q', '-b', 'main'])
    await Bun.write(join(MAIN, 'readme.md'), '# widgets\n')
    await git(MAIN, ['add', '-A'])
    await git(MAIN, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    // the display name comes from the remote, not the directory (which is "widgets-main")
    await git(MAIN, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'])
    await git(MAIN, ['worktree', 'add', '-q', '-b', 'feat/tree', LINKED])

    const a = makeClient(MAIN)
    mainClient = a.client
    await a.connected
    mainSession = await readSessionFile(MAIN)

    const b = makeClient(LINKED)
    linkedClient = b.client
    await b.connected
    linkedSession = await readSessionFile(LINKED)
  })

  afterAll(async () => {
    await mainClient?.close().catch(() => {})
    await linkedClient?.close().catch(() => {})
  })

  interface Origin {
    repoKey: string
    repo: string
    repoKind: string
    remote?: string
    worktree: string
    worktreeIsMain: boolean
  }

  async function origins(): Promise<Record<string, Origin>> {
    const res = await fetch(`${base}/api/sessions`, {
      headers: { 'X-Sidecar-Token': session.token },
    })
    const { sessions } = (await res.json()) as { sessions: { id: string; origin: Origin }[] }
    return Object.fromEntries(sessions.map(s => [s.id, s.origin]))
  }

  test('both checkouts report the same repo identity, named from the remote', async () => {
    const all = await origins()
    const main = all[mainSession.sessionId]!
    const linked = all[linkedSession.sessionId]!

    expect(main.repoKey).toBe(linked.repoKey) // one repo, so one group in the tree
    expect(main.repoKey).toContain('widgets-main') // keyed on the MAIN worktree
    expect(main.repo).toBe('widgets') // remote name wins over the directory name
    expect(linked.repo).toBe('widgets')
    expect(main.repoKind).toBe('git')
    expect(main.remote).toBe('git@github.com:acme/widgets.git')
  })

  test('the linked worktree is distinguished from the main checkout', async () => {
    const all = await origins()
    const main = all[mainSession.sessionId]!
    const linked = all[linkedSession.sessionId]!

    expect(main.worktree).toBe('widgets-main')
    expect(main.worktreeIsMain).toBe(true)
    expect(linked.worktree).toBe('widgets-feat-tree')
    expect(linked.worktreeIsMain).toBe(false)
  })

  test('a session outside a repo still gets its own group, marked as a directory', async () => {
    const all = await origins()
    const plain = all[session.sessionId]!
    expect(plain.repoKind).toBe('dir')
    // the agent process reports its resolved cwd (/var → /private/var on macOS)
    expect(plain.repoKey).toBe(realpathSync(PROJECT_A))
    expect(plain.repo).toBe(PROJECT_A.split('/').pop()!)
    expect(plain.worktreeIsMain).toBe(true)
  })

  test('the canvas builds the tree from repo, worktree, then session', async () => {
    const canvas = await (await fetch(base)).text()
    expect(canvas).toContain('function buildTree')
    expect(canvas).toContain('function renderWorktree')
    // grouping keys on the repo, and the worktree level is conditional on there
    // being more than one checkout
    expect(canvas).toContain('repos.get(o.repoKey)')
    expect(canvas).toContain('repo.list.length < 2')
  })

  test('--status names the worktree when it is not the main checkout', async () => {
    const out = await cli('--status')
    expect(out).toContain('widgets/widgets-feat-tree · feat/tree')
    expect(out).toContain('widgets · main')
  })
})

describe('version skew', () => {
  test('/health advertises the protocol and whether it is idle', async () => {
    const h = (await health()) as Health & { protocol: number; idle: boolean }
    expect(h.protocol).toBe(1)
    // our own session is attached, so it is not idle
    expect(h.idle).toBe(false)
  })

  test('a session reports the version of the client half, not just the server', async () => {
    const res = await fetch(`${base}/api/sessions`, {
      headers: { 'X-Sidecar-Token': session.token },
    })
    const { sessions } = (await res.json()) as {
      sessions: { id: string; version: string; protocol: number }[]
    }
    const mineRow = sessions.find(s => s.id === session.sessionId)!
    expect(mineRow.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(mineRow.protocol).toBe(1)
  })

  test('the entry path is persisted so the server can restart into newer code', async () => {
    const state = (await Bun.file(join(HOME, 'state.json')).json()) as {
      sessions: { id: string; entry: string }[]
    }
    const saved = state.sessions.find(s => s.id === session.sessionId)
    expect(saved?.entry).toBe(realpathSync(SERVER))
  })

  test('/api/restart refuses when no session is running anything newer', async () => {
    const res = await fetch(`${base}/api/restart`, {
      method: 'POST',
      headers: { 'X-Sidecar-Token': session.token },
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { reason: string }).reason).toContain('newer than')
  })

  test('--status reports the protocol alongside the version', async () => {
    expect(await cli('--status')).toContain('protocol 1')
  })
})

/**
 * Adoption is the interesting decision a starting client makes, and it can only
 * be exercised against a server claiming to be a different release — so these
 * stand one up. Their own home and port: they move server.json around, which the
 * shared server above must never see.
 */
describe('adopting an existing server', () => {
  const SKEW_HOME = mkdtempSync(join(tmpdir(), 'sidecar-skew-'))
  const SKEW_PORT = String(49_900 + Math.floor(Math.random() * 80))
  const SKEW_ENV = {
    ...process.env,
    SIDECAR_HOME: SKEW_HOME,
    SIDECAR_PORT: SKEW_PORT,
    SIDECAR_IDLE_EXIT_MS: '0',
  } as Record<string, string>

  /** Enough of a sidecar server for a client to discover, probe, and attach to. */
  function fakeServer(opts: { version: string; idle: boolean }) {
    const seen = { shutdowns: 0, registrations: 0 }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch(req): Response {
        const path = new URL(req.url).pathname
        if (path === '/health') {
          return Response.json({
            ok: true,
            server: 'agent-sidecar',
            version: opts.version,
            protocol: 1,
            pid: 999_999,
            idle: opts.idle,
            sessions: { live: opts.idle ? 0 : 1, total: 1 },
            canvasTabs: 0,
          })
        }
        if (path === '/api/shutdown') {
          seen.shutdowns++
          // a real server exits here; going quiet is what the client waits for
          setTimeout(() => server.stop(true), 10)
          return Response.json({ ok: true })
        }
        if (path === '/api/sessions' && req.method === 'POST') {
          seen.registrations++
          const origin = new URL(req.url).origin
          return Response.json({ sessionId: 's99-fake', url: origin, version: opts.version })
        }
        if (path.endsWith('/attach')) {
          const stream = new ReadableStream({
            start: ctrl => ctrl.enqueue(': ping\n\n'), // held open, never closed
          })
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    mkdirSync(SKEW_HOME, { recursive: true })
    Bun.write(
      join(SKEW_HOME, 'server.json'),
      JSON.stringify({
        server: 'agent-sidecar',
        version: opts.version,
        protocol: 1,
        pid: 999_999,
        port: server.port,
        url: base,
        token: 'f'.repeat(32),
        startedAt: new Date().toISOString(),
      }),
    )
    return { server, seen, url: base }
  }

  test('replaces an older server that nobody is watching', async () => {
    const fake = fakeServer({ version: '0.0.1', idle: true })
    const project = mkdtempSync(join(tmpdir(), 'sidecar-skew-idle-'))
    const c = makeClient(project, SKEW_ENV)
    try {
      await c.connected
      const s = await readSessionFile(project)
      // it stopped the stale one and came up on our own configured port
      expect(fake.seen.shutdowns).toBe(1)
      expect(fake.seen.registrations).toBe(0)
      expect(s.port).toBe(Number(SKEW_PORT))
      expect(s.url).not.toBe(fake.url)
    } finally {
      await c.client.close().catch(() => {})
      await cliIn(SKEW_ENV, '--stop')
      fake.server.stop(true)
    }
  }, 30_000)

  test('/api/restart hands the canvas to the newest entry a session reported', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sidecar-skew-restart-'))
    const c = makeClient(project, SKEW_ENV)
    try {
      await c.connected
      const s = await readSessionFile(project)
      const auth = { 'X-Sidecar-Token': s.token, 'Content-Type': 'application/json' }

      // stand in for a second harness that pinned a newer release; `entry` is the
      // real one, so the successor it launches is code that actually runs
      await fetch(`${s.url}/api/sessions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          cwd: project,
          label: 'future',
          version: '99.0.0',
          protocol: 1,
          entry: realpathSync(SERVER),
        }),
      })

      const before = ((await (await fetch(`${s.url}/health`)).json()) as Health).pid
      const res = await fetch(`${s.url}/api/restart`, { method: 'POST', headers: auth })
      expect(res.status).toBe(200)
      expect((await res.json()) as { to: string }).toMatchObject({ ok: true, to: '99.0.0' })

      // the successor takes the same port, so the canvas URL never moves
      let after = before
      for (let i = 0; i < 100 && after === before; i++) {
        await Bun.sleep(100)
        after = await fetch(`${s.url}/health`)
          .then(r => r.json() as Promise<Health>)
          .then(h => h.pid)
          .catch(() => before)
      }
      expect(after).not.toBe(before)
      expect(Number(new URL(s.url).port)).toBe(Number(SKEW_PORT))
    } finally {
      await c.client.close().catch(() => {})
      await cliIn(SKEW_ENV, '--stop')
    }
  }, 30_000)

  test('adopts an older server that has something attached', async () => {
    const fake = fakeServer({ version: '0.0.1', idle: false })
    const project = mkdtempSync(join(tmpdir(), 'sidecar-skew-busy-'))
    const c = makeClient(project, SKEW_ENV)
    try {
      await c.connected
      const s = await readSessionFile(project)
      // left alone: restarting it would have been visible to whoever is attached
      expect(fake.seen.shutdowns).toBe(0)
      expect(fake.seen.registrations).toBeGreaterThan(0)
      expect(s.sessionId).toBe('s99-fake')
      expect(s.url).toBe(fake.url)
    } finally {
      await c.client.close().catch(() => {})
      fake.server.stop(true)
    }
  }, 30_000)
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
