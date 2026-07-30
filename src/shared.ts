/**
 * Shared vocabulary for the two halves of agent-sidecar: the singleton server
 * (one detached process per machine) and the per-session MCP client.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const VERSION = '0.10.0'

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
