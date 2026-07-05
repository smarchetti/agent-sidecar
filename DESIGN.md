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

## Accessibility

WCAG AA. `--text-dim` is the floor for body text on ink surfaces — don't go dimmer. Copy buttons have `aria-label`s; the diorama has a `role="img"` narrative label; keyboard focus follows document order.
