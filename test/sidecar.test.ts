import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const SERVER = join(REPO, 'sidecar.ts')
const WORKDIR = mkdtempSync(join(tmpdir(), 'sidecar-test-'))

interface Session {
  pid: number
  port: number
  url: string
  token: string
}

function makeClient() {
  const client = new Client({ name: 'test', version: '0.0.1' })
  const connected = client.connect(
    new StdioClientTransport({
      command: 'bun',
      args: [SERVER],
      cwd: WORKDIR,
      env: { ...process.env, SIDECAR_PORT: '0' } as Record<string, string>,
      stderr: 'pipe',
    }),
  )
  return { client, connected }
}

async function readSession(expectNotPid?: number): Promise<Session> {
  for (let i = 0; i < 50; i++) {
    try {
      const s = (await Bun.file(join(WORKDIR, '.sidecar', 'session.json')).json()) as Session
      if (expectNotPid === undefined || s.pid !== expectNotPid) return s
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error('session.json never appeared')
}

const text = (r: any): string => r.content[0].text

let client: Client
let session: Session
let base: string

async function webhook(body: unknown, opts: { token?: string; raw?: boolean } = {}) {
  return fetch(`${base}/api/webhook`, {
    method: 'POST',
    headers: {
      ...(opts.raw ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.token === undefined ? {} : { 'X-Sidecar-Token': opts.token }),
    },
    body: opts.raw ? String(body) : JSON.stringify(body),
  })
}

beforeAll(async () => {
  const c = makeClient()
  client = c.client
  await c.connected
  session = await readSession()
  base = session.url
})

afterAll(async () => {
  await client.close()
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
})

describe('http surface', () => {
  test('session.json has port, url, and token', () => {
    expect(session.port).toBeGreaterThan(0)
    expect(session.url).toBe(`http://127.0.0.1:${session.port}`)
    expect(session.token).toMatch(/^[0-9a-f]{32}$/)
  })

  test('health endpoint responds', async () => {
    const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean }
    expect(health.ok).toBe(true)
  })

  test('canvas page is served with the session token injected', async () => {
    const canvas = await (await fetch(base)).text()
    expect(canvas).toContain('Claude Sidecar')
    expect(canvas).toContain(session.token)
    expect(canvas).toContain('sandbox="allow-scripts')
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

  test('artifacts survive a server restart (persistence)', async () => {
    const c2 = makeClient()
    await c2.connected
    try {
      const listed = await c2.client.callTool({ name: 'list_artifacts', arguments: {} })
      expect(text(listed)).toContain(id)
    } finally {
      await c2.client.close()
    }
    // note: the main instance's session/base stay valid — its port never changed
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
    const res = await fetch(`${base}/api/webhook?token=${session.token}`, {
      method: 'POST',
      body: 'query-param event',
    })
    expect(res.status).toBe(200)
    const drained = await client.callTool({ name: 'get_interactions', arguments: {} })
    expect(text(drained)).toContain('query-param event')
  })
})

describe('await_interaction', () => {
  test('unblocks when an interaction arrives while waiting', async () => {
    setTimeout(() => webhook({ artifactId: 'art-1', payload: { choice: 'b' } }, { token: session.token }), 400)
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
    await webhook({ artifactId: 'art-1', payload: { n: 1 } }, { token: session.token })
    await Bun.sleep(100)
    const t0 = Date.now()
    const res = await client.callTool({ name: 'await_interaction', arguments: { timeout_seconds: 10 } })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(text(res)).toContain('"n":1')
  })

  test('artifact_id filter skips non-matching interactions and leaves them queued', async () => {
    await webhook({ artifactId: 'other-artifact', payload: { stale: true } }, { token: session.token })
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
      await webhook({ artifactId: 'wrong', payload: { w: 1 } }, { token: session.token })
      await webhook({ artifactId: 'right', payload: { r: 1 } }, { token: session.token })
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

describe('interaction log', () => {
  test('interactions.jsonl records everything with seq/kind/payload', async () => {
    const jsonl = await Bun.file(join(WORKDIR, '.sidecar', 'interactions.jsonl')).text()
    const lines = jsonl.trim().split('\n').map(l => JSON.parse(l))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    for (const l of lines) {
      expect(l.seq).toBeGreaterThan(0)
      expect(['interaction', 'webhook']).toContain(l.kind)
      expect(l.receivedAt).toBeString()
    }
  })
})

describe('port handling', () => {
  test('falls back to an ephemeral port when the preferred port is taken', async () => {
    const c2 = new Client({ name: 'test2', version: '0.0.1' })
    await c2.connect(
      new StdioClientTransport({
        command: 'bun',
        args: [SERVER],
        cwd: WORKDIR,
        // ask for the port our main instance already holds
        env: { ...process.env, SIDECAR_PORT: String(session.port) } as Record<string, string>,
        stderr: 'pipe',
      }),
    )
    try {
      const s2 = await readSession(session.pid)
      expect(s2.port).not.toBe(session.port)
      const health = (await (await fetch(`${s2.url}/health`)).json()) as { ok: boolean }
      expect(health.ok).toBe(true)
    } finally {
      await c2.close()
    }
  })
})
