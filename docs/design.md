# MeetingSpace — Design Brief (`design.md`)

> The agent-readable design system for this project. **Read before writing any UI code.** Reference its tokens, component states, and Do's/Don'ts — don't invent values. This is the contract Stage V's design pass checks the running deliverable against.
>
> Origin: remixed from the Linear baseline in the `awesome-design-md` collection (VoltAgent), inverted from Linear's dark canvas to a light/spacious direction per Phase 1.5 discovery.

---

## 1. Visual theme & atmosphere

- **Mood:** Calm, precise, editorial — a focused tool that gets out of the way during a live meeting.
- **Density:** Spacious. Generous whitespace, room to breathe, few competing elements.
- **Reference apps:** Linear (precision, restraint, single accent), Obsidian (calm content-first workspace), with Notion's friendliness in the capture surface.
- **One-line north star:** *"It should feel like Linear in daylight — sharp and quiet, never busy."*

## 2. Color palette & roles

A light remix of Linear's palette: their lavender accent and hairline-border discipline, inverted onto a white canvas.

```css
:root {
  /* Surfaces */
  --color-bg:             #fbfbfd;  /* app canvas */
  --color-surface:        #f4f5f7;  /* sidebar, sunken panels */
  --color-surface-raised: #ffffff;  /* cards, note blocks, modals */
  /* Text */
  --color-text:           #0f0f14;  /* Linear's near-black */
  --color-text-muted:     #6b6b76;  /* secondary */
  --color-text-subtle:    #8a8f98;  /* tertiary / captions */
  /* Brand / accent — Linear lavender, used sparingly */
  --color-primary:        #5e6ad2;
  --color-primary-hover:  #4f5ac0;
  --color-primary-soft:   #eceef9;  /* tinted bg for selected nav, focus halo */
  /* Semantic */
  --color-success:        #27a644;
  --color-warning:        #c77700;
  --color-danger:         #dc2626;
  --color-border:         #e6e6ec;  /* hairline, 1px */
}
```

Contrast target: **WCAG AA** (4.5:1 body, 3:1 large). The design pass checks it.

## 3. Typography rules

```css
:root {
  --font-sans: "Inter", system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;  /* transcripts, code, key field */
  /* Type scale (rem) — from Linear's 13/14/16/18/22/28/36 */
  --text-xs:   0.8125;  /* 13px captions, metadata */
  --text-sm:   0.875;   /* 14px secondary, buttons */
  --text-base: 1;       /* 16px body / notes */
  --text-lg:   1.125;   /* 18px subsection */
  --text-xl:   1.375;   /* 22px section heading */
  --text-2xl:  1.75;    /* 28px page / space title */
  /* Weights */
  --weight-normal: 400; --weight-medium: 500; --weight-semibold: 600;
  /* Line heights */
  --leading-tight: 1.2; --leading-body: 1.6;
  /* Tracking — Linear's signature negative tracking on large text */
  --tracking-title: -0.02em; --tracking-body: -0.005em;
}
```

Hierarchy: **5 levels** (space title → section → subsection → body → caption/metadata). Flat typography is a design-pass fail.

## 4. Component stylings

| Component | Default | Hover | Active | Disabled | Focus (a11y) |
|---|---|---|---|---|---|
| Button (primary) | lavender `--color-primary`, white text, radius-md | `--color-primary-hover` | slight inset | 40% opacity, no pointer | 2px lavender ring, 2px offset |
| Button (secondary) | `--color-surface-raised`, 1px border, text color | `--color-surface` fill | inset | 40% opacity | visible ring |
| Button (ghost/icon) | transparent | `--color-surface` | — | 40% | visible ring |
| Input / text field | white, 1px `--color-border`, radius-md | — | border → `--color-primary`, soft halo | muted bg | border + halo |
| Card / note block | `--color-surface-raised`, 1px border, radius-lg, shadow-sm | shadow-md on draggable | — | — | — |
| Nav item (space/session) | transparent, muted text | `--color-surface-raised` | `--color-primary-soft` bg + text color, left accent bar | — | visible ring |
| Screenshot thumb | radius-md, 1px border | scale 1.01 + shadow-md | — | — | ring |
| Modal (settings/generate) | `--color-surface-raised`, radius-lg, shadow-lg, scrim overlay | — | — | — | trap focus |

Every interactive element has a **visible focus ring**. No `outline: none` without a replacement.

> **Nav-item hover clarification (M01.C → recorded M02.A):** hover uses `--color-surface-raised`, not `--color-surface`. The §2 sidebar background is itself `--color-surface`, so a `--color-surface` hover would be invisible; the shipped implementation lifts the hovered item to the raised surface. (Resolves the M01 gap-analysis "contradicted" item.)

## 5. Layout principles

```css
:root {
  /* Spacing scale (rem) — use these, not arbitrary values */
  --space-1: 0.25; --space-2: 0.5; --space-3: 0.75;
  --space-4: 1;    --space-6: 1.5; --space-8: 2; --space-12: 3;
  /* Radii */
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px; --radius-xl: 16px;
  /* Structure */
  --sidebar-width: 264px;
  --llm-panel-width: 380px;
  --content-max: 820px;   /* note column stays readable, doesn't sprawl */
}
```

- **Structure:** Three-zone — **left sidebar** (spaces + sessions list, ~264px) · **center capture canvas** (notes/screenshots/transcript, content capped ~820px for readability) · **right LLM panel** (chat + generate, ~380px, collapsible).
- **Whitespace rhythm:** spacing only from the scale; spacious defaults — card padding `--space-6` (24px), section gaps `--space-8`+. No one-off margins.
- **Alignment:** left-aligned throughout. Centering reserved for empty states and modals only.

## 6. Depth & elevation

```css
:root {
  --shadow-sm: 0 1px 2px rgba(15,15,20,0.05);
  --shadow-md: 0 4px 12px rgba(15,15,20,0.08);
  --shadow-lg: 0 16px 40px rgba(15,15,20,0.12);
}
```

Light mode leans on **hairline borders first, soft shadows second** (Linear's discipline translated to light). Note blocks/cards: border + shadow-sm. Draggable/hovered items lift to shadow-md. Modals: shadow-lg + scrim. No decorative shadows, no glow.

## 7. Do's and Don'ts

**Do:**

- Use the tokens above for every color, space, radius, and type value.
- Reserve lavender for primary actions, selected state, focus rings, and links — one accent, used sparingly (Linear's core rule).
- Keep one primary action per view.
- Use mono only for transcripts, the API-key field, and code.

**Don't:**

- Hard-code hex, px spacing, or font sizes outside the token set.
- Ship raw Electron/browser defaults (unstyled buttons, default fonts, no spacing).
- Introduce a second accent color (no orange/pink/teal competing with lavender).
- Use pill-rounded CTAs or heavy drop shadows.

## 8. Responsive behavior

- **Primary target:** desktop app (Electron window). Not mobile.
- **Min window:** ~960×640; below that the LLM panel collapses to a toggle.
- **Reflow:** at narrow widths the right LLM panel becomes an overlay drawer; sidebar can collapse to icons. Center canvas always stays ≥ readable width.
- **Touch vs hover:** mouse/keyboard primary; hover affordances (drag lift) are enhancements, not required for any action.

## 9. Agent prompt guide

- *"Add a {component} matching `docs/design.md` — use the §2 tokens, §4 button/input states, and the §5 spacing scale. One lavender accent only."*
- *"Review this view against `docs/design.md` §7 Do's/Don'ts and the §2 AA contrast target."*
- *"This is a desktop Electron window — follow §8, no mobile breakpoints; collapse the LLM panel below ~960px."*
