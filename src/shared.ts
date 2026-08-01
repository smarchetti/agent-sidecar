/**
 * Shared vocabulary for the two halves of agent-sidecar: the singleton server
 * (one detached process per machine) and the per-session MCP client.
 */
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const VERSION = '0.11.0'

/**
 * Version of the client↔server HTTP contract (/api/sessions, /attach, /api/wait,
 * /api/webhook, /events), which is a different thing from the package version.
 *
 * Package versions move every release; this moves only when that surface breaks.
 * That distinction is the point: a 0.11 client and a 0.12 server share a canvas
 * quite happily, so releases don't have to disturb a running server. Bump this
 * only when an older client genuinely cannot talk to a newer server.
 */
export const PROTOCOL = 1

/**
 * Machine-wide state dir. The server is a singleton across every project, so
 * its discovery file and canvas state live here rather than in any one repo.
 * SIDECAR_HOME lets tests (and power users) run an isolated server.
 */
export const SIDECAR_HOME = process.env.SIDECAR_HOME || join(homedir(), '.agent-sidecar')

/**
 * Discovery file, scoped to the protocol so incompatible servers can coexist
 * rather than fight over one port and one file. Protocol 1 keeps the historical
 * `server.json` name, so upgrading from a pre-protocol build finds its own server.
 */
export const SERVER_FILE = join(
  SIDECAR_HOME,
  PROTOCOL === 1 ? 'server.json' : `server-p${PROTOCOL}.json`,
)
export const STATE_FILE = join(SIDECAR_HOME, 'state.json')
export const SERVER_LOG = join(SIDECAR_HOME, 'server.log')

/**
 * Fixed port so the canvas URL stays bookmarkable across restarts. If a foreign
 * process holds it, the server scans upward — discovery goes through
 * server.json, so the actual port is never ambiguous.
 */
export const PREFERRED_PORT = Number(process.env.SIDECAR_PORT ?? 8765)

/** Contents of ~/.agent-sidecar/server.json — how clients find the server. */
export interface ServerInfo {
  server: 'agent-sidecar'
  version: string
  /** Absent in files written before protocol versioning existed; treat as 1. */
  protocol?: number
  pid: number
  port: number
  url: string
  token: string
  startedAt: string
  /** Set when the server exited cleanly. The file is kept (rather than deleted)
   *  so the next server reuses the token and old watcher URLs stay valid. */
  stoppedAt?: string
}

/**
 * Where a session is working, as the canvas groups it: repo → worktree → session.
 *
 * Two checkouts of one repo (a main worktree plus `git worktree add` siblings) share
 * a `repoKey`, so they nest under one repo instead of looking like unrelated projects.
 * A cwd that isn't a repo at all still gets a group of its own, named after the
 * directory — `repoKind` is what the UI uses to label it differently.
 */
export interface SessionOrigin {
  /** Stable identity of the repo: its main worktree's root path (the cwd when not a repo). */
  repoKey: string
  /** Display name for the repo level — from the origin remote when there is one. */
  repo: string
  repoKind: 'git' | 'dir'
  /** origin remote URL, when the checkout has one. */
  remote?: string
  /** The checkout this session sits in — directory name of its own worktree root. */
  worktree: string
  /** False only for a linked worktree; the canvas shows the worktree level when a repo has more than one. */
  worktreeIsMain: boolean
}

/** Fallback origin for a plain directory: its own group, no nesting. */
export function originFromCwd(cwd: string): SessionOrigin {
  const name = basename(cwd) || cwd
  return { repoKey: cwd, repo: name, repoKind: 'dir', worktree: name, worktreeIsMain: true }
}

/** `git@github.com:owner/name.git` / `https://host/owner/name` → `name`. */
export function repoNameFromRemote(remote: string): string | undefined {
  const cleaned = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const last = cleaned.split(/[/:]/).pop()
  return last || undefined
}

export interface ArtifactSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** One thing the user (or an external caller) sent to one session. */
export interface Interaction {
  seq: number
  receivedAt: string
  kind: 'interaction' | 'webhook' | 'note'
  sessionId: string
  artifactId?: string
  artifactTitle?: string
  payload: unknown
}

export async function readServerInfo(): Promise<ServerInfo | null> {
  try {
    const info = (await Bun.file(SERVER_FILE).json()) as ServerInfo
    return info.url && info.token ? info : null
  } catch {
    return null // no server has ever run here (or the file is mid-write)
  }
}

/** What /health tells a client about the server it just found. */
export interface ServerProbe {
  version: string
  protocol: number
  /** True when nothing is attached and no canvas tab is open — safe to replace unseen. */
  idle: boolean
  liveSessions: number
  canvasTabs: number
  pid: number
}

/**
 * Ask whoever holds this URL what they are. Returns null for "not a live
 * agent-sidecar", which covers a dead server, a foreign process on the port,
 * and a connection that never answers.
 */
export async function probeServer(url: string, timeoutMs = 1500): Promise<ServerProbe | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const h = (await res.json()) as Record<string, any>
    if (h.server !== 'agent-sidecar') return null
    return {
      version: typeof h.version === 'string' ? h.version : '0.0.0',
      // a pre-protocol server reports nothing; it spoke protocol 1 by definition
      protocol: typeof h.protocol === 'number' ? h.protocol : 1,
      idle: h.idle === true,
      liveSessions: h.sessions?.live ?? 0,
      canvasTabs: h.canvasTabs ?? 0,
      pid: h.pid ?? 0,
    }
  } catch {
    return null
  }
}

/** True if something at this URL is a live agent-sidecar server. */
export async function isServerAlive(url: string, timeoutMs = 1500): Promise<boolean> {
  return (await probeServer(url, timeoutMs)) !== null
}

/**
 * `a` vs `b` as dotted numeric versions: -1, 0, or 1. Prerelease suffixes are
 * dropped rather than ordered — we only need "is the running server behind us",
 * and treating 0.12.0-rc1 as 0.12.0 errs toward leaving it alone.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0]!.split('.').map(n => Number(n) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Renders an interaction the way Claude reads it back in a tool result. */
export function formatInteraction(i: Interaction): string {
  const origin =
    i.kind === 'interaction'
      ? `artifact ${i.artifactId}${i.artifactTitle ? ` ("${i.artifactTitle}")` : ''}`
      : i.kind === 'note'
        ? 'the user (typed into the canvas)'
        : 'external webhook'
  return `[${i.receivedAt}] from ${origin}:\n${JSON.stringify(i.payload)}`
}
