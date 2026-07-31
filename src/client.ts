/**
 * Client half: finds (or starts) the singleton server and holds one session on it.
 *
 * Every MCP process is a thin client. It owns no canvas state — it registers a
 * session, keeps a liveness stream open so the server knows the agent is still
 * there, and turns tool calls into HTTP calls.
 */
import { mkdir } from 'node:fs/promises'
import { openSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  SERVER_LOG,
  SIDECAR_HOME,
  isServerAlive,
  originFromCwd,
  readServerInfo,
  repoNameFromRemote,
  type ServerInfo,
  type SessionOrigin,
} from './shared.ts'

const SPAWN_TIMEOUT_MS = 10_000

/**
 * Start the server detached so it outlives this MCP process — and outlives
 * Claude Code itself, which is the point of a singleton. Output goes to
 * ~/.agent-sidecar/server.log; a background process with no log is undebuggable.
 */
function spawnServer(entry: string) {
  const log = openSync(SERVER_LOG, 'a')
  Bun.spawn([process.execPath, entry, '--serve'], {
    cwd: SIDECAR_HOME, // don't hold a project directory open
    env: process.env,
    stdin: 'ignore',
    stdout: log,
    stderr: log,
    detached: true,
  }).unref()
}

/**
 * Returns a live server, starting one if needed. Concurrent MCP starts are safe:
 * every loser of the bind race exits on its own, and all clients converge on the
 * winner recorded in server.json.
 */
export async function ensureServer(entry: string): Promise<ServerInfo> {
  const existing = await readServerInfo()
  if (existing && (await isServerAlive(existing.url))) return existing

  await mkdir(SIDECAR_HOME, { recursive: true })
  spawnServer(entry)

  const deadline = Date.now() + SPAWN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await Bun.sleep(100)
    const info = await readServerInfo()
    if (info && (await isServerAlive(info.url))) return info
  }
  throw new Error(
    `sidecar server did not come up within ${SPAWN_TIMEOUT_MS / 1000}s — see ${SERVER_LOG}`,
  )
}

/** Runs git in `cwd`, returning trimmed stdout — or null for any failure. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
    const out = (await new Response(proc.stdout).text()).trim()
    return (await proc.exited) === 0 && out ? out : null
  } catch {
    return null // git isn't installed
  }
}

/** Best-effort branch name, used as the session's label in the canvas. */
async function gitLabel(cwd: string): Promise<string | undefined> {
  // fails in a repo with no commits yet — the server falls back to "session"
  const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out && out !== 'HEAD' ? out : undefined
}

/**
 * Which repo and which checkout of it this session is in.
 *
 * `--git-common-dir` points at the *main* worktree's git dir from anywhere in the
 * repo, which is what makes two worktrees group together. It comes back relative
 * to cwd in a main worktree and absolute in a linked one, so it always needs
 * resolving before use.
 */
async function gitOrigin(cwd: string): Promise<SessionOrigin> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  const [toplevel, commonDir] = (out ?? '').split('\n')
  if (!toplevel || !commonDir) return originFromCwd(cwd) // not a repo, or no git

  const resolved = resolve(cwd, commonDir)
  // …/main-repo/.git → …/main-repo; a bare repo (…/repo.git) is already the root
  const mainRoot = basename(resolved) === '.git' ? dirname(resolved) : resolved
  const remote = (await git(cwd, ['config', '--get', 'remote.origin.url'])) ?? undefined
  const repo =
    (remote ? repoNameFromRemote(remote) : undefined) ??
    basename(mainRoot).replace(/\.git$/, '') ??
    mainRoot

  return {
    repoKey: mainRoot,
    repo: repo || mainRoot,
    repoKind: 'git',
    remote,
    worktree: basename(toplevel) || toplevel,
    worktreeIsMain: toplevel === mainRoot,
  }
}

export interface WaitResult {
  status?: string
  seq?: number
  receivedAt?: string
  kind?: 'interaction' | 'webhook' | 'note'
  sessionId?: string
  artifactId?: string
  artifactTitle?: string
  payload?: unknown
}

/**
 * One agent session on the singleton server.
 *
 * The attach stream doubles as failure detection in both directions: if it drops
 * because the server restarted, we re-register under the same session id and the
 * canvas picks up exactly where it was.
 */
export class SessionLink {
  info: ServerInfo
  sessionId = ''
  readonly cwd: string
  readonly project: string
  readonly origin: SessionOrigin
  private label: string | undefined
  private closed = false
  private readonly entry: string

  private constructor(
    info: ServerInfo,
    entry: string,
    cwd: string,
    origin: SessionOrigin,
    label?: string,
  ) {
    this.info = info
    this.entry = entry
    this.cwd = cwd
    this.origin = origin
    // what the agent's own instruction text calls this session's home
    this.project = origin.worktree
    this.label = label
  }

  static async open(entry: string, cwd = process.cwd()): Promise<SessionLink> {
    const info = await ensureServer(entry)
    const [origin, label] = await Promise.all([gitOrigin(cwd), gitLabel(cwd)])
    const link = new SessionLink(info, entry, cwd, origin, label)
    await link.register()
    void link.attachLoop()
    return link
  }

  get url(): string {
    return this.info.url
  }

  get token(): string {
    return this.info.token
  }

  private async register(): Promise<void> {
    const res = await fetch(`${this.info.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': this.info.token },
      body: JSON.stringify({
        resume: this.sessionId || undefined,
        cwd: this.cwd,
        label: this.label,
        pid: process.pid,
        origin: this.origin,
      }),
    })
    if (!res.ok) throw new Error(`could not register session: ${res.status} ${await res.text()}`)
    this.sessionId = ((await res.json()) as { sessionId: string }).sessionId
  }

  /**
   * Holds the liveness stream open for the life of this process, reconnecting if
   * the server restarts under us.
   */
  private async attachLoop(): Promise<void> {
    let backoffMs = 250
    while (!this.closed) {
      try {
        const res = await fetch(`${this.info.url}/api/sessions/${this.sessionId}/attach`, {
          headers: { 'X-Sidecar-Token': this.info.token },
        })
        if (res.ok && res.body) {
          backoffMs = 250
          // drain until the server goes away; the bytes themselves are just pings
          for await (const _chunk of res.body) void _chunk
        }
      } catch {
        // server died or is restarting — fall through to recovery
      }
      if (this.closed) return
      await Bun.sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 5_000)
      try {
        await this.recover()
      } catch {
        // keep retrying: Claude's next tool call surfaces the error if it persists
      }
    }
  }

  /** Re-point at a (possibly new) server process and re-claim our session id. */
  private async recover(): Promise<void> {
    this.info = await ensureServer(this.entry)
    await this.register()
  }

  close(): void {
    this.closed = true
  }

  /** Authenticated request against our own session, with one recovery retry. */
  async api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const target = `${this.info.url}${path.replace('{s}', this.sessionId)}`
    let res: Response
    try {
      res = await fetch(target, {
        ...init,
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          'X-Sidecar-Token': this.info.token,
          ...(init.headers as Record<string, string> | undefined),
        },
      })
    } catch (err) {
      if (!retry) throw err
      await this.recover() // server went away mid-call
      return this.api<T>(path, init, false)
    }

    // 408 is a real answer from /api/wait (nobody clicked), not a failure
    if (!res.ok && res.status !== 408) {
      const body = (await res.text()).slice(0, 300)
      // a restarted server has no memory of our session until we re-register
      if (res.status === 404 && retry && body.includes('unknown session')) {
        await this.recover()
        return this.api<T>(path, init, false)
      }
      throw new SidecarApiError(res.status, body)
    }
    return (await res.json()) as T
  }
}

export class SidecarApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`sidecar server ${status}: ${body}`)
    this.name = 'SidecarApiError'
  }
}
