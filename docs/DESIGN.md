# OpsTrellis design system: "Quiet Glass"

The design is restrained and precise, in the spirit of native macOS apps, Linear and Raycast. It
replaces "Aurora Glass": users found the gradients dated and the alignment sloppy.

## Hard rules (checked automatically)

1. **No gradients anywhere.** `grep -riE "gradient" src/ --include=*.css --include=*.tsx` must
   return nothing. That covers backgrounds, text, borders, masks and charts. No glows, no
   coloured shadows, no decorative blobs or orbs.
2. **One accent colour, used solid and sparingly.** It appears only on the primary button, the
   focus ring, links, toggles when on, selected or active states, the chart fill, and the live
   recording dot (`--rec`, red). Every other surface is neutral.
3. **4px grid.** Every margin, padding, gap, width, height and radius is a multiple of 4. The
   exception is 1px hairlines.
4. **Shared edges.** These must line up:
   - The page title's left edge and the left edge of every card or list on the page.
   - The top of the page header and the top of the sidebar's first nav item.
   - The search field and the section heading beside it (same height, vertically centred).
   - Text columns inside list rows, aligned between rows.
5. **Glass only where something is behind it.** That means the sticky page header (content scrolls
   under it), modals over a dimmed scrim, toasts, menus and popovers, and the dictation overlay
   pill over other apps. Glass is a translucent neutral fill with backdrop blur and a 1px
   hairline. Cards and the sidebar are solid.
6. **No decorative imagery.** No orbs, illustrations or hero banners. Empty states are a short
   sentence plus one button.

## Tokens

```css
:root {
  --bg: #f6f6f7;            /* window */
  --surface: #ffffff;       /* cards, sidebar */
  --surface-2: #f1f1f3;     /* hover, inputs, kbd */
  --line: #e4e4e7;          /* 1px borders/dividers */
  --line-strong: #d4d4d8;   /* hovered input, button and card borders */
  --text: #18181b;
  --text-2: #52525b;        /* secondary */
  --muted: #71717a;         /* tertiary, meta; AA on --surface */
  --accent: #3b5bdb;        /* solid indigo-blue */
  --accent-hover: #3451c6;
  --accent-soft: #edf0fc;   /* selected nav / tag background */
  --accent-text: #2f4ac0;   /* accent used as text (AA) */
  --rec: #e5484d;           /* recording dot, danger */
  --ok: #2f9e6e;
  --glass: rgba(255, 255, 255, 0.72);
  --glass-line: rgba(0, 0, 0, 0.08);
  --blur: saturate(180%) blur(20px);
  --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08); /* modals/menus/toasts only */
  --radius: 12px; --radius-sm: 8px; --radius-xs: 6px;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1); --fast: 0.12s;
  --font: "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI Variable", Cantarell, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0e10; --surface: #161618; --surface-2: #1f1f22; --line: #2a2a2e; --line-strong: #3a3a40;
    --text: #ededef; --text-2: #b4b4bb; --muted: #8b8b94;
    --accent: #5b7cfa; --accent-hover: #6d8bfb; --accent-soft: #1d2340; --accent-text: #93a8ff;
    --glass: rgba(22, 22, 24, 0.72); --glass-line: rgba(255, 255, 255, 0.08);
    --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06);
  }
}
```

Without `backdrop-filter`, or when `prefers-reduced-transparency` is set, glass falls back to
`--surface`.

## Motion

Smooth, never showy. Everything uses `--ease`; nothing bounces.

- Interactive controls fade background, border and text colour over `--fast` (120 ms).
- Pressing a button, nav item, tab or chip scales it to 0.98.
- Hovered inputs, buttons and tone cards take `--line-strong`; rows in list cards take `--surface-2`.
- A page's content fades up 4px on open (180 ms). Modals pop in (180 ms); toasts rise 8px (200 ms).
- `prefers-reduced-motion` turns all of it off.

## Type scale (Inter, tabular numbers on all figures)

| Use | Size / line height / weight |
|---|---|
| Page title | 22 / 28 / 600 |
| Section heading | 15 / 20 / 600 |
| Body | 14 / 20 / 400 |
| Small and meta | 12 / 16 / 400–500 |
| Stat value | 28 / 32 / 600 |
| Overline (rare) | 11 / 16 / 600, uppercase, +0.04em |

## Layout

- **Sidebar.** Full window height, 232px wide, `--surface`, 1px right hairline (not floating).
  Padding 16px.
  - Logo row: 32px high. The logo mark is a 24px square in a solid accent colour with white bars.
  - Nav items: 32px high, 8px horizontal padding, radius 8, 16px icon with a 12px gap.
  - Active item: `--accent-soft` background with `--accent-text` text and icon, and no extra bars.
  - Footer: Settings, then a one-line status row (dot + "Ready" + kbd).
- **Content.**
  - Scroll container with 32px left/right padding and a centred column of max 880px.
  - Sticky page header: 64px tall, glass, title on the left and actions on the right, both
    vertically centred.
  - The title's left edge equals the column's left edge.
  - 24px between sections and 12px between a section heading and its content.
- **Cards.** `--surface`, 1px `--line`, radius 12, no shadow. Inner padding 16px; list rows use
  12px vertical by 16px horizontal.
- **Buttons.** All 32px tall, radius 8. Inline text links (`.link`, accent text with no box) are
  text, not buttons, and are exempt.
  - Primary: solid accent with white text.
  - Secondary: `--surface` with a 1px line.
  - Ghost and icon buttons: transparent, with `--surface-2` on hover.
- **Inputs.** 32px tall, `--surface`, 1px line, radius 8. Focus is a 2px accent ring.
- **Kbd.** 20px tall, 6px horizontal padding, `--surface-2`, 1px line, 12px/500, radius 6. It sits
  inline in body text, never inside headings.

## Screens

- **Home.**
  - Header: "Home".
  - A one-line hint card: "Hold <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd> to dictate ·
    tap for hands-free", with "Command mode" and "Paste last" as secondary items in the same row,
    right-aligned.
  - A stat strip: one card with three equal columns and 1px dividers. Each column shows a muted
    label above a stat value.
  - History: a section heading row with "History" on the left and a 240px search field on the
    right, then rows grouped by day. The day label is a small muted heading aligned to the
    column's left edge.
  - Each row: a fixed 64px time column (muted, tabular), the text, and a meta line (app · latency)
    underneath. The text uses the full width. Row actions (correct, polish again, copy, delete)
    appear on hover or keyboard focus in a small toolbar at the row's top right: solid `--surface`,
    1px `--line` hairline, radius 8, 4px padding, 32px icon buttons, no shadow. While correcting, the
    actions take their own column so they never cover the text area.
- **Insights.**
  - A stat strip.
  - A heatmap of 12px cells with a 4px gap, coloured by stepped opacities of the solid accent
    (0.15 / 0.35 / 0.6 / 1).
  - Category bars: solid accent on a `--surface-2` track, 8px tall, radius 4.
- **Lists** (Dictionary, Snippets, Transforms) use the same list card. Notes, Notetaker, Style and
  Settings follow the same grid. Style tone options are equal-width selectable cards: the selected
  one has an accent border and an `--accent-soft` fill, with a check icon.
- **Settings.** A sticky section nav on the left, grouped under overlines: Dictation (Shortcuts,
  Voice input, Text insertion, Permissions), Speech & AI (Transcription, Local models, AI polish) and
  App (General, Privacy, Account, About). The body follows the same order, one card per section.
- **Keyboard.** ⌘1–⌘5 (Ctrl on Linux) open the sidebar pages, ⌘, opens Settings, ⌘F focuses the
  page's search field. Nav items name their shortcut in a tooltip.
- **Overlay pill.**
  - Shape: 44 high, radius 22. Surface `rgba(24,24,27,.88)` with blur and a 1px
    `rgba(255,255,255,.1)` hairline. The width follows the state over 160 ms:

    | State | Width | Contents |
    |---|---|---|
    | Push-to-talk | 240 | Red dot, lattice, live text |
    | Hands-free | 280 | Lock and `m:ss` timer added |
    | Opening mic | 240 | Hollow dot (don't speak yet); "Opening mic…" if it takes over 0.4 s |
    | Transcribing / Polishing | 200 | A column (or, for polishing, a diagonal) sweeps the lattice, plus the stage label |
    | Outcome | fits text, ≤ 344 | ✓ "Inserted · 0.6 s" (0.9 s), or a still red dot and the problem (3 s) |

  - **Lattice:** the signature waveform. 2px white dots on a 4px pitch, 5 rows. Live levels light
    dots outward from the centre row. Only their opacity changes (0.18 off, 0.85 on).
  - The start sound plays when the microphone delivers audio, not on key press.
  - On Linux there are cancel and stop icon buttons while recording.
  - No colour other than the red dot.
