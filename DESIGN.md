# Design

Visual system for the agent-sidecar site (`site/index.html`, `site/docs.html`). Direction: **Terminal & Canvas** — a dark ink world where artifacts and interactive elements are the light sources, dramatizing the product's own physics (dark terminal ⇄ luminous canvas).

## Theme

Dark only. The scene: a developer in a terminal at night; the canvas is the bright thing that opens beside it.

## Color (OKLCH)

| Token | Value | Role |
| --- | --- | --- |
| `--ink-0` | `oklch(15.5% 0.012 55)` | page background |
| `--ink-1` | `oklch(19% 0.014 55)` | panels, code blocks, terminal |
| `--ink-2` | `oklch(24% 0.018 55)` | raised details |
| `--line` | `oklch(31% 0.02 55)` | hairlines, borders |
| `--text` | `oklch(93% 0.012 65)` | primary text (≈13:1 on ink-0) |
| `--text-dim` | `oklch(76% 0.022 60)` | secondary text (≈6:1 on ink-0, AA) |
| `--ember` | `oklch(74% 0.155 45)` | THE accent — links, tool chips, marks, CTA bg |
| `--ember-hot` | `oklch(81% 0.16 55)` | hover / highlighted ember |
| `--ember-ink` | `oklch(22% 0.05 45)` | text on ember surfaces |
| `--canvas` | `oklch(96.5% 0.02 75)` | the glowing artifact panel (index hero only) |
| `--glow` | layered ember alpha shadows | "the canvas is on" |

Strategy: **Committed dark** — ink carries the surface, ember is the single voice color, the light `--canvas` panel appears only where an artifact is literally depicted. Neutrals are tinted toward the brand hue (h≈55), never generic gray.

## Typography

- **Bricolage Grotesque** (400/500/600/800, optical sizing) — display and prose. Confident, characterful grotesque.
- **Martian Mono** (400/600) — terminal content, code, commands, sidebar group labels, nav CTA. Mono is *literal*: it appears only where a terminal, code, or a machine identifier genuinely appears. Never as decoration.
- Display: `clamp(2.5rem, 5.6vw, 4.3rem)`, weight 800, tracking −0.03em, `text-wrap: balance`.
- Body 16px/1.6–1.65; docs prose capped at 68ch.

## Signature elements

- **The diorama** (index hero): animated terminal + glowing canvas panels acting out the product loop. Plays once on load (7s), rests in the completed state; caret keeps blinking. `prefers-reduced-motion` shows the final state statically.
- **The rail** (`#how`): a single connected line with four stations (dot + mono tool chip + prose), the lit station glowing ember. Horizontal on desktop, vertical on mobile.
- **Spec ledger** (`#features`): definition list — mono ember key column + prose value, hairline separators. No cards.
- **Terminal windows**: `--ink-1` panels with three hollow chrome dots, mono content, ember `›` prompts, copy buttons on command lines.
- **Callouts** (docs): full-border `--ink-1` panel with an ember ✳ marker (never a colored side-stripe).

## Shared shell

Both pages use the **identical** sticky topnav: `✳ agent-sidecar` brand · Docs / GitHub / npm links · mono ember **Install** button; blurred ink backdrop, hairline bottom border. Footer likewise identical. `aria-current` marks the active page.

## Layout & motion rules

- Container: 1160px max, `padding-inline: clamp(20px, 4vw, 48px)`. **Never use the `padding: X 0` shorthand on a `.wrap` element** — it clobbers the inline padding (use `padding-block`).
- Mobile grid overrides must use `minmax(0, 1fr)`, not bare `1fr`, or nowrap terminal content blows out the track.
- Motion: entrance choreography only in the hero diorama; elsewhere restraint (color transitions ≤200ms, ease-out). Everything honors `prefers-reduced-motion`.
- z-index scale: `--z-nav: 10` (only layer in use; extend semantically if needed).

## Canvas shell (`src/canvas.html`)

The shipped canvas UI shares the site's ember accent but uses system fonts (it must work offline), its own geometry tokens, and — unlike the site — **both a dark and a light theme**. Rules keeping it coherent:

- **Every colour is a semantic token**, named for its job (`--bg`, `--panel`, `--raised`, `--line`, `--text`, `--text-dim`, `--text-faint`, `--accent`, `--accent-ink`, `--accent-wash`, `--ok`, `--danger`) and defined once per theme. No rule may hardcode a colour — a test fails the build if one does, because a literal silently belongs to one theme.
- **Light is not dark inverted.** The accent drops from `oklch(74% …)` to `oklch(50% …)` so it stays legible as text on a light surface, and `--accent-ink` flips light because the accent doubles as a button background.
- **Never dim text with `opacity`.** It reads as a shortcut but multiplies against the surface and quietly breaks contrast; use `--text-faint`, which is a real colour that passes AA in both themes. Opacity is for genuinely inert things: disabled controls, separator glyphs.
- Theme resolution: `data-theme` on `<html>` pins a choice (persisted), and with no choice `prefers-color-scheme` decides. The saved value is applied by an inline script in `<head>` — applying it later flashes the wrong theme.
- Both themes are verified with a WCAG contrast pass over every text role; AA is the floor.

- **One type scale, four sans steps** (`--t-xs` 11 / `--t-sm` 12 / `--t-md` 13 / `--t-lg` 15). Mono sits one step below the sans beside it so the two optically match.
- **Mono is a meaning, not a texture.** It marks machine identifiers only — repo, worktree, branch, `host:port`, version, artifact paths. Counts, tags, hints, relative times, and status text are sans. (The sidebar once set counts and labels in mono; it read as decoration and made the column noisy.)
- **Spacing is a 4px rhythm** (`--s-1`…`--s-5`). No ad hoc paddings — values like `3px 8px 5px` are what made the tree feel unresolved.
- **Prefer space to rules.** Repo groups separate with `--s-5`, not a hairline; the tree keeps exactly one guide line (the artifact list) and the status bar separates counters with `·`.
- **Times are relative** (`now`, `3m`, `2h` in the sidebar; `3m ago` where there's room), refreshed on a 30s tick, with the absolute time on hover. A canvas you watch while an agent works should not make you subtract clock times.
- **Radius by nesting depth, three steps only.** `--r-sm: 6px` for inner controls and nested rows (artifact rows, disclosure twists, dismiss buttons), `--r-md: 8px` for the rows and controls that contain them (session/worktree rows, buttons, inputs), `--r-lg: 12px` for the stage frame — the one large surface. `--r-pill` is for status objects (badge, toast), never layout. Full-bleed bars — headers, pane labels, composer, status bar — stay square; a bar that spans the window has no corners to round.
- **Bar heights are shared tokens.** `--header-h` drives *both* the sidebar header and the stage top bar so their bottom hairlines form one continuous line across the app; `--statusbar-h` does the same for the footer (and the toast offset keys off it). Never set either height inline.

## Accessibility

WCAG AA. `--text-dim` is the floor for body text on ink surfaces — don't go dimmer. Copy buttons have `aria-label`s; the diorama has a `role="img"` narrative label; keyboard focus follows document order.
