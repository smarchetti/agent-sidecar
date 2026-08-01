#!/usr/bin/env bun
/**
 * agent-sidecar — a visual canvas for coding agents.
 *
 * One singleton server per machine holds the canvas; every agent session attaches
 * to it as a thin MCP client and appears as its own session in the UI.
 *
 *   agent-sidecar            run as an MCP server over stdio (what agents launch)
 *   agent-sidecar --serve    run the singleton server in the foreground
 *   agent-sidecar --stop     shut the singleton server down
 *   agent-sidecar --status   show the server and its sessions
 */
import { runMcp } from './mcp.ts'
import { runServer, stopServer } from './server.ts'
import { PROTOCOL, SIDECAR_HOME, VERSION, probeServer, readServerInfo } from './shared.ts'

interface SessionRow {
  id: string
  project: string
  origin?: { repo: string; worktree: string; worktreeIsMain: boolean }
  label: string
  /** What this session's client is running — not necessarily the server's version. */
  version?: string | null
  live: boolean
  queued: number
  artifacts: unknown[]
}

/** `repo · branch`, with the worktree spelled out when it isn't the main checkout. */
function where(s: SessionRow): string {
  const o = s.origin
  if (!o) return s.project
  return o.worktreeIsMain ? o.repo : `${o.repo}/${o.worktree}`
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h${mins % 60}m`
}

async function status(): Promise<string> {
  const info = await readServerInfo()
  const probe = info ? await probeServer(info.url) : null
  if (!info || !probe) {
    return (
      `agent-sidecar ${VERSION} (protocol ${PROTOCOL})\n` +
      `server    not running (state in ${SIDECAR_HOME})`
    )
  }
  // the running server can legitimately be a different release from this CLI
  const drift = probe.version === VERSION ? '' : `  ← this CLI is ${VERSION}`
  const lines = [
    `agent-sidecar ${VERSION} (protocol ${PROTOCOL})`,
    `server    running v${probe.version} · protocol ${probe.protocol} · pid ${info.pid} · ` +
      `${info.url} · up ${ago(info.startedAt)}${drift}`,
  ]
  try {
    const res = await fetch(`${info.url}/api/sessions`, {
      headers: { 'X-Sidecar-Token': info.token },
    })
    const { sessions } = (await res.json()) as { sessions: SessionRow[] }
    const live = sessions.filter(s => s.live).length
    lines.push(`sessions  ${live} live, ${sessions.length - live} ended`)
    for (const s of sessions) {
      const queued = s.queued ? `, ${s.queued} queued` : ''
      // only worth printing when it disagrees with the server it is attached to
      const ver = s.version && s.version !== probe.version ? ` · client v${s.version}` : ''
      lines.push(
        `  ${s.live ? '●' : '○'} ${s.id}  ${where(s)} · ${s.label}${ver}  ` +
          `(${s.artifacts.length} artifact(s)${queued})`,
      )
    }
  } catch (err) {
    lines.push(`sessions  could not read: ${err}`)
  }
  return lines.join('\n')
}

const flags = new Set(process.argv.slice(2))

if (flags.has('--version') || flags.has('-v')) {
  console.log(VERSION)
} else if (flags.has('--help') || flags.has('-h')) {
  console.log(
    [
      `agent-sidecar ${VERSION} — a visual canvas for coding agents`,
      '',
      '  agent-sidecar            run as an MCP server over stdio (what agents launch)',
      '  agent-sidecar --serve    run the singleton canvas server in the foreground',
      '  agent-sidecar --stop     shut the singleton canvas server down',
      '  agent-sidecar --status   show the server and its sessions',
      '',
      'Env: SIDECAR_PORT (default 8765), SIDECAR_HOME (default ~/.agent-sidecar),',
      '     SIDECAR_IDLE_EXIT_MS (server self-exit when unused; 0 disables)',
    ].join('\n'),
  )
} else if (flags.has('--serve')) {
  await runServer()
} else if (flags.has('--stop')) {
  console.log(await stopServer())
} else if (flags.has('--status')) {
  console.log(await status())
} else {
  // import.meta.path is this entry (src/sidecar.ts in dev, dist/sidecar.js when
  // installed) — the client re-launches it with --serve to start the server
  await runMcp(import.meta.path)
}
