
## Runtime: develop with Bun, ship runtime-agnostic

**`src/` must not use `Bun.*` APIs or `bun:` imports.** Since 0.12.0 the shipped
bundle runs under plain `node` — the Claude Code plugin launches
`node ${CLAUDE_PLUGIN_ROOT}/dist/sidecar.js`, and requiring Bun on every user's
PATH was the biggest install-funnel tax. Use `node:` builtins in `src/`:

- `node:http` + the `nodeHandler` adapter in `server.ts`, not `Bun.serve`
- `node:child_process` `spawn`, not `Bun.spawn`
- `node:fs/promises` `readFile`, not `Bun.file`
- `node:timers/promises` `setTimeout`, not `Bun.sleep`
- `fileURLToPath(import.meta.url)`, not `import.meta.path`

The two runtimes genuinely disagree — bun's `node:http` shim does not emit
response `'close'` when a peer dies, which silently breaks session liveness — so
`bun test` and `SIDECAR_TEST_RUNTIME=node bun test` both run in CI. Fix a
disagreement in a way that works on both rather than picking a side.

Bun stays the *tooling*: `bun install`, `bun test`, `bun build`, `bun run <script>`,
and `bun <file>` to run the working source. Bun loads `.env`, so no dotenv.

`dist/sidecar.js` is committed, because the plugin runs it out of the plugin
directory. Rebuild it (`bun run build`) in any commit that touches `src/` — CI
fails if it has drifted.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

There is no framework and no frontend build step. The entire canvas UI is one
hand-written file, `src/canvas.html` — plain HTML, CSS custom properties, and
vanilla JS, no React, no Tailwind, no bundled client assets.

It is pulled into the server as a string:

```ts
import canvasTemplateImport from './canvas.html' with { type: 'text' }
```

`bun build` inlines that at build time (it survives `--target=node`), which is
what keeps `dist/sidecar.js` a single self-contained file with no runtime file
reads and no `node_modules`. The server substitutes `__SIDECAR_TOKEN__` and
`__SIDECAR_VERSION__` into it before serving.

Colours must be semantic tokens defined once per theme — a test fails if any CSS
rule hardcodes an `oklch()` or hex literal. The design system, including the type,
spacing, and radius scales, is documented in DESIGN.md.

## Running it

```sh
bun install
bun test                              # working source under bun
bun run test:node                     # built bundle under node (what ships)
claude --mcp-config dev.mcp.json      # your working copy, live (disable the plugin first)
bun src/sidecar.ts --status           # inspect the running singleton server
```

`dev.mcp.json` is deliberately not named `.mcp.json`: a plugin-root `.mcp.json` is
auto-discovered inside installed plugin copies and would double-register the server.
