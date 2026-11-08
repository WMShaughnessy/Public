# Site Style Guide

This guide records the strict formatting rules of the site, taken directly
from the existing pages (`index.html`, `About.html`, `BusinessCard.html`,
`RSSBrief.html`, `WeatherBrief.html`, `Gallery.html`) and their stylesheets.
Every new page and every change to an existing page must follow it. When the
code and this guide disagree, fix whichever one is wrong in the same change.

The look is **brutalist editorial / Bauhaus**: flat primary colors, heavy
black borders, square corners, bold Helvetica, uppercase micro-labels, and
no decoration that does not serve a purpose.

`WeatherBrief_utils/NWS_HTML/` is a separate demo kit with its own CSS and is
not covered by this guide.

---

## 1. Design tokens

Every page declares the same `:root` block, in this order, with these exact
values. Do not add new colors or borders inline; add a token here first and
copy it to every stylesheet.

```css
:root {
  --red:    rgb(217, 33, 33);   /* #D92121 */
  --blue:   rgb(27, 75, 154);   /* #1B4B9A */
  --yellow: rgb(247, 213, 0);   /* #F7D500 */
  --black:  #1A1A1A;
  --white:  #FFFFFF;
  --grey:   #666666;
  --light:  #444444;
  --border: 3px solid #1A1A1A;
  --border-thick: 4px solid #1A1A1A;
  --font: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --max-w: 660px;
}
```

Page-specific tokens are allowed only when a page needs a value no other page
uses (Gallery adds `--stage: #F2F2F2` for photo backgrounds). Pages that do
not need `--light`, `--border` or `--max-w` may omit them (About).

## 2. Color

### Palette and roles

| Token | Role |
| --- | --- |
| `--red` | Accent block; error text and error-card stripe; "Business" category; severe weather |
| `--blue` | Accent block; stats-count bar; primary action button; inline content links (`.preview-link`); focus outline |
| `--yellow` | Accent block; notice-card stripe; hover frame on thumbnails; stale markers; "Government/Legal" category |
| `--black` | All text, all borders, filled buttons and tags, hover state of outline buttons |
| `--white` | Page and card backgrounds; text on red, blue and black |
| `--grey` | Secondary text: dates, times, labels, placeholders, status rows |
| `--light` | Body/preview paragraph text |

### Rules

- Only the three primaries plus black, white and greys. No gradients.
- Text on red, blue or black is white. Text on yellow is **always black**.
- Accent blocks are solid fills with no content inside them.
- Cards rotate their accent color in the fixed order **red, yellow, blue**
  (`const COLORS = ["red", "yellow", "blue"]` in each page script). Reuse
  `colorForIndex(i)` rather than choosing colors by hand.
- Overlays use the black token at reduced opacity:
  `rgba(26, 26, 26, 0.5)` for modals, `rgba(26, 26, 26, 0.85)` for the
  photo viewer.

### Allowed neutrals (outside the tokens)

These hard-coded greys are in use and are the only ones allowed:

| Value | Use |
| --- | --- |
| `#fafafa` | Hover/focus tint on white surfaces; sources panel background |
| `#efefef` | Hover on list items inside a tinted panel |
| `#F2F2F2` | Photo stage (`--stage`) |
| `#e0e0e0`, `#e8e8e8`, `#ddd`, `#eee` | 1px hairline dividers, spinner track, progress track |
| `#888` | Footer text |

Status colors: `#2a8a2a` (feed OK), `#c48a00` (stale), `rgb(217, 150, 0)`
(moderate weather severity). Do not introduce others.

## 3. Typography

- **One family only:** `var(--font)` (Helvetica Neue, Helvetica, Arial).
  Buttons and inputs must set `font-family: var(--font)` explicitly because
  they do not inherit it.
- **Two weights only:** normal and `bold`. Write `font-weight: bold`, never a
  number.
- Italic is reserved for notes and advisory descriptions (`.data-note`,
  `.advisory-desc`).
- No `border-radius` on text containers, no text shadows, no web fonts.

### Type scale (desktop)

| Role | Size | Weight | Letter-spacing | Case | Line-height |
| --- | --- | --- | --- | --- | --- |
| Page title (`.header-title`) | 36px | bold | -1px | as written | 1 |
| Home card name (`.card-name`) | 36px | bold | -1px | as written | 1 |
| Centered card title (About, loading) | 28px | bold | -0.5px | as written | default |
| Card / article title (`.card-title`) | 18px | bold | 0 | as written | 1.3 |
| Stats-count bar | 14px | bold | 0 | uppercase text | default |
| Body / preview (`.card-preview`) | 14px | normal | 0 | sentence | 1.6 |
| Data row | 14px (value 15–16px) | normal / bold | 0 | sentence | 1.5 |
| Secondary body (notes, advisories) | 12–13px | normal | 0 | sentence | 1.5 |
| Date / time line | 12px | normal | 2px | UPPERCASE | default |
| Micro-label (status, subtitles) | 11–12px | normal or bold | 1–2px | UPPERCASE | default |
| Footer text | 11px | normal | 1px | UPPERCASE | default |
| Buttons, tags, source badge | 10px | bold | 1.5px | UPPERCASE | 1.4 |
| Category chip, group label | 9px | bold | 1–2px | UPPERCASE | default |

Rules of thumb that hold everywhere:

- **Large text tightens** (negative letter-spacing); **small uppercase text
  opens up** (1–2px). Never letter-space lowercase body text.
- Every uppercase label is set with `text-transform: uppercase` in CSS, not
  typed in capitals, except dynamic labels written by script (for example
  `— ARTICLES`, the uppercased date).
- Dates use `toLocaleDateString('en-US', { weekday: 'long', year: 'numeric',
  month: 'long', day: 'numeric' })`, times use 12-hour `h:mm AM`, both
  uppercased.

## 4. Borders, corners and depth

- Square corners everywhere. `border-radius` is allowed only for genuinely
  round things: spinners, chart dots, slider thumbs (`50%`) and slider tracks
  (`2px`).
- No drop shadows. `box-shadow` is allowed only as a focus/hover halo on the
  satellite slider and chart dot.
- Border weights, and nothing in between:
  - `--border-thick` (4px): page shell (header, stats bar, footer, modal
    box, viewer panel, overlay cards).
  - `--border` (3px): content cards, card accents, status/error/empty rows,
    thumbnails, stages.
  - `2px solid var(--black)`: buttons, section dividers.
  - `1.5px solid`: category chips, source items.
  - `1px solid #e0e0e0`: hairline dividers inside a card.
- **Stacked blocks share a border.** Adjacent bordered blocks overlap by
  the border width (`margin-bottom: -4px` on the header row, `margin-top:
  -3px` on the sources panel) or drop the touching side (`border-left: none`,
  `border-top: none`). Never show a doubled 6–8px line.

## 5. Spacing

- The vertical gap between stacked blocks is **4px** (`margin-bottom: 4px`).
  Cards, status rows, error cards and thumbnail grids all use it.
- Section breaks are larger: 16px before the footer on the app pages (20px on
  Home), 16px between feed groups, `20px 0 6px` above a section divider.
- Button groups use `gap: 4px`. Meta rows use `gap: 8px`.
- Card padding: `18px 24px 20px` (article/photo cards), `20px 24px`
  (weather cards), `28px 30px` (Home cards), `40px 30px` (centered cards).
- Header body padding `20px 30px`; stats body `10px 14px`; footer body
  `14px 20px`.
- Use the existing values above; do not invent new in-between numbers.

## 6. Layout

### Page frame

```css
.page-wrap      { width: 100%; padding: 30px 15px; }
.main-container { max-width: var(--max-w); margin: 0 auto; width: 100%; }
```

All content is one centered column, at most 660px wide. Use flexbox for
rows; use CSS grid only for true grids (thumbnails, forecast grid).
`box-sizing: border-box` is set on everything.

### Breakpoints

Exactly two, written as max-width queries at the end of the stylesheet:

| Query | Page padding | Purpose |
| --- | --- | --- |
| `@media (max-width: 600px)` | `12px 10px` | Phones: shrink accents, padding and type |
| `@media (max-width: 380px)` | unchanged | Small phones: shrink again |

Responsive values for the shared shell:

| Element | Desktop | ≤600px | ≤380px |
| --- | --- | --- | --- |
| Header left accent | 140px | 84px | 50px |
| Header right accent | 60px | 36px | 20px |
| Header body padding | 20px 30px | 14px 18px | 10px 12px |
| Header title | 36px | 26px (-0.5px) | 20px |
| Date / time | 12px | 10px | 9px (1px spacing) |
| Buttons | 10px, 4px 9px | 9px, 4px 7px | 8px, 3px 6px |
| Footer yellow / red / blue | 50 / 50 / 30px | 30 / 30 / 18px | 20 / 20 / 12px |
| Footer body padding | 14px 20px | 10px 14px | 8px 10px |
| Footer text | 11px | 11px | 9px |

Home keeps a 30px title at 600px and 24px at 380px because its header has
no stats-count bar under it. Business Card uses its own narrower accents
(120/70/44px left, 50/30/20px right).

## 7. Page shell (required on every full page)

Each full page is built from the same four blocks, in this order, inside
`.page-wrap > .main-container`, each preceded by a banner comment:

```html
<!-- ============ HEADER ============ -->
<!-- ============ STATS BAR ============ -->
<!-- ============ <CONTENT NAME> ============ -->
<!-- ============ FOOTER ============ -->
```

### Header

```html
<div class="header-row">
  <div class="header-accent-left"></div>
  <div class="header-body">
    <div class="header-title" id="header-title"><a href="index.html" style="color:inherit;text-decoration:none;">Page Name</a></div>
    <div class="header-date"  id="header-date"></div>
    <div class="header-time"  id="header-time"></div>
  </div>
  <div class="header-accent-right"></div>
</div>
```

- Left accent is wide (140px) and colored; right accent is narrow (60px) and
  **always yellow**.
- Left accent color: red on Home, RSS Brief and Gallery; blue on Weather
  Brief and Business Card.
- The title always links back to `index.html`.
- The clock redraws at the top of each minute and on `visibilitychange`.

### Stats bar

Two forms:

- **Home:** a single row: blue accent (60px), body holding `.nav-link`
  buttons, black accent (40px).
- **App pages (RSS, Weather, Gallery):** stacked at all sizes. A colored
  `.stats-count` bar (white, bold, 14px) above a white `.stats-label` panel
  holding `.controls` rows. The count bar is blue on RSS Brief and Gallery,
  red on Weather Brief, so it never matches the header's left accent.
  `.stats-accent` is kept in the markup but hidden.

### Content

A wrapper `div` with an id (`#articles-wrapper`, `#content-wrapper`,
`#gallery-wrapper`) and `margin-top: 4px`, filled by the page script.

### Footer

```html
<div class="footer-row">
  <div class="footer-yellow"></div>
  <div class="footer-body">
    <span class="footer-text"><a href="#" style="color:inherit;text-decoration:none;">Page Name</a> · Personal Use Only</span>
  </div>
  <div class="footer-red"></div>
  <div class="footer-blue"></div>
</div>
```

Color order is fixed: **yellow, (text), red, blue**. The text is always
`<Page Name> · Personal Use Only` with a middle dot (`·`) and spaces.

### Centered card pages

Small single-message screens (About, the Weather Brief loading overlay) use
a centered card instead of the shell: an 8px accent strip (yellow on About;
cycling red, yellow, blue while loading) beside a 4px-bordered body, max
480px wide, `width: calc(100% - 30px)`, with a 28px bold title and a 12px
uppercase grey status line.

## 8. Components

### Accent-strip card

The core content unit: a narrow colored strip to the left of a bordered body.

```html
<div class="article-card">
  <div class="card-accent red"></div>
  <div class="card-body">…</div>
</div>
```

- Accent width: 6px on app pages, 8px on Home (grows to 16px on hover).
- Accent has `border: var(--border); border-right: none;` so it shares the
  body's left border.
- Accent color classes: `.red`, `.yellow`, `.blue` only.
- Body: white, `border: var(--border)`, `flex: 1; min-width: 0`.

### Buttons

All buttons are outline-to-solid toggles with the same base:

```css
font-family: var(--font);
font-size: 10px;
font-weight: bold;
text-transform: uppercase;
letter-spacing: 1.5px;
padding: 4px 9px;
border: 2px solid var(--black);
background: var(--white);
color: var(--black);
cursor: pointer;
transition: background 0.1s, color 0.1s;
line-height: 1.4;
flex-shrink: 0;
```

- Hover and `.active`: `background: var(--black); color: var(--white)`.
- Disabled: `opacity: 0.4; cursor: not-allowed`.
- Classes in use: `.nav-link`, `.filter-btn`, `.view-btn`, `.refresh-btn`,
  `.sources-toggle-btn`. Reuse one of these before adding another.
- **Solid buttons** invert the pattern: black (or blue for the primary
  action) with white text, turning white with black/blue text on hover
  (`.card-read`, `.zip-go`, `.modal-btn`, `.nav-link.dl-btn`).
- Button labels may carry a single text glyph: `↻ Refresh`, `Go →`,
  `← Prev`, `Next →`, `✕ Close`, `Sources ▾`. Icons, when used, are inline
  12px SVGs that switch stroke/fill to white on hover.

### Tags and chips

- **Source tag / card tag:** black fill, white 10px bold uppercase text,
  `padding: 4px 10px`, no border.
- **Category chip:** 9px bold uppercase, `padding: 3px 8px`,
  `border: 1.5px solid var(--black)`, filled with the category color.

### Status, notice, error and empty states

| Component | Style |
| --- | --- |
| `.status-row` | 3px border, `16px 20px`, 12px grey uppercase, 14px spinner |
| `.error-card` | 3px border with a 6px red left border, red 13px text |
| `.notice-card` | 3px border with a 6px yellow left border, 12px `--light` text |
| `.empty-state` | 3px border, `40px 20px`, centered 13px grey uppercase |

Spinner: 14px circle, `2px solid #ddd` with a black top, `0.7s linear`
rotation. Progress bar: 3px track `#eee`, black fill.

### Section divider

`2px solid var(--black)` bottom border, label 11px bold uppercase with
2px letter-spacing.

### Overlays

Modal and viewer boxes use `--border-thick`, a white panel, and a header bar
split from the body by a 4px border. The colored count/label block on the
left of a viewer bar is blue with white bold uppercase text. Close buttons
are square (`28px`) outline buttons.

## 9. Motion

- Hover transitions are fast: `0.1s` for color swaps, `0.12–0.15s` for
  background tints and accent width.
- Entry animation: `cardIn`, fade up from `translateY(6–8px)` over
  `0.2–0.3s ease`. Home staggers its three cards by about 0.07s.
- Overlays fade in over `0.15–0.2s`; modals also slide up 12px.
- Respect `prefers-reduced-motion: reduce` for any new non-essential
  animation.
- No bouncing, scaling (beyond `scale(0.98)` on press) or parallax.

## 10. Markup conventions

- Every page starts with `<!DOCTYPE html>`, `<html lang="en">`, `UTF-8`
  charset and the `width=device-width, initial-scale=1.0` viewport meta.
- `<title>` is the plain page name ("RSS Brief", "Weather Brief"). It
  matches the header title and the footer text.
- Each page links three favicons, in this order:

  ```html
  <link rel="icon" href="Favicons/PageName-32.png" sizes="32x32">
  <link rel="icon" href="Favicons/PageName.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="Favicons/PageName-180.png">
  ```

- Two-space indentation in HTML, CSS and JS.
- Class names are lowercase kebab-case, prefixed by component
  (`header-`, `stats-`, `card-`, `footer-`, `viewer-`, `sat-`, `fc-`).
  State classes are short adjectives: `.active`, `.visible`, `.open`,
  `.show`, `.hidden`, `.disabled`.
- IDs are kebab-case and used only for script hooks.
- Plain `<div>`/`<span>` markup with classes; buttons are `<button>`, links
  are `<a>`. Add `aria-label`, `role` and `aria-live` on dialogs and
  icon-only controls.
- Inline styles are used in one place only: the
  `style="color:inherit;text-decoration:none;"` on header and footer links.
  Do not add others.

## 11. File and code organization

- **Pages** live at the repo root in PascalCase: `PageName.html`.
- **Assets** for a page live in `PageName_utils/`:
  `PageName_styles.css` and `PageName_script.js`.
- Small static pages (Home, About, Business Card) keep their CSS in a single
  `<style>` block in the `<head>`.
- **Favicons** live in `Favicons/` as `PageName.svg`, `PageName-32.png` and
  `PageName-180.png`.
- Page configuration sits in an inline `<script>` that sets
  `window.PAGENAME_CONFIG` (for example `BRIEF_CONFIG`, `WEATHER_CONFIG`,
  `GALLERY_CONFIG`) under a `CONFIGURATION` banner comment, before the page
  script is loaded at the end of `<body>`.
- Every stylesheet opens with a banner naming the page and file, then is
  divided by section comments in this order:

  ```css
  /* ============================================================
     Page Name — PageName_styles.css
     Brutalist editorial aesthetic: heavy borders, bold accents,
     clean typography, no decoration without purpose.
     ============================================================ */

  /* ---------- Tokens ---------- */
  /* ---------- Reset & Base ---------- */
  /* ---------- Layout ---------- */
  /* ---------- Header ---------- */
  /* ---------- Stats Bar ---------- */
  /* ---------- Controls ---------- */
  /* … page components … */
  /* ---------- Status / Loading ---------- */
  /* ---------- Error / Empty ---------- */
  /* ---------- Footer ---------- */
  /* ---------- Responsive ---------- */
  ```

- One declaration per line in external stylesheets. Single-line rules are
  fine for short state variants and for the aligned rows in the responsive
  blocks.
- Use tokens (`var(--black)`, `var(--border)`) rather than repeating raw
  values.
- Scripts are plain browser JavaScript with no build step and no framework.
  They open with a `/** … */` header listing the page's features and use
  `/* ===== */` banners between sections.

## 12. Favicons

Favicons follow one Bauhaus icon family:

- 64×64 SVG on a tile with 14px rounded corners (`rx="14"`).
- Tile background is one primary: blue (Home, RSS Brief, Weather Brief),
  red (About, Business Card) or yellow (Gallery).
- Built from flat rectangles and arcs in the five palette colors plus a
  paper cream `#F4EFE4` for card shapes.
- Every foreground shape casts the same hard black (`#1A1A1A`) offset
  shadow, a copy of the shape shifted down and right.
- Export PNGs at 32px and 180px alongside the SVG.

## 13. Known deviations

These exist in the code today. Keep them in mind when editing and bring
them into line when the file is next touched:

- Home's footer sits 20px below the content; the app pages use 16px.
- Business Card wraps its whole shell in one bordered `.card-wrap` with
  4px `.card-divider` bars, instead of separate bordered rows, and its
  footer carries a sentence (`.footer-msg`, 13px, not uppercase) instead of
  the standard footer text.
- Weather Brief's cards use `padding: 20px 24px`; RSS Brief and Gallery use
  `18px 24px 20px`.

## Checklist for a new page

1. Copy the token block, reset and base rules exactly.
2. Build the header, stats bar, content wrapper and footer from section 7.
3. Pick a left-accent color and a stats-count color that differ from each
   other; keep the right header accent yellow.
4. Use only existing button, card, tag and state components.
5. Add both breakpoints with the shell values from section 6.
6. Add the three favicon files and link them in the order above.
7. Add a card for the page on Home, continuing the red, yellow, blue order.
