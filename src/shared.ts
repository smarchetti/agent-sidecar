/**
 * Shared vocabulary for the two halves of agent-sidecar: the singleton server
 * (one detached process per machine) and the per-session MCP client.
 */
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const VERSION = '0.11.0'

/**
 * Machine-wide state dir. The server is a singleton across every project, so
 * its discovery file and canvas state live here rather than in any one repo.
 * SIDECAR_HOME lets tests (and power users) run an isolated server.
 */
export const SIDECAR_HOME = process.env.SIDECAR_HOME || join(homedir(), '.agent-sidecar')
export const SERVER_FILE = join(SIDECAR_HOME, 'server.json')
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

/** True if something at this URL is a live agent-sidecar server. */
export async function isServerAlive(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    return ((await res.json()) as { server?: string }).server === 'agent-sidecar'
  } catch {
    return false
  }
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
