<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/coredraft_logo_dark.png">
    <img src="assets/coredraft_logo.png" alt="coredraft" width="480">
  </picture>
</p>

# coredraft

A minimal, distraction-free drawing canvas for quick sketches, diagrams, and mind maps. Runs entirely in the browser — no installation, no backend, no build step.

> Note: fonts are loaded from Google Fonts (with graceful fallback to system fonts when offline); everything else is fully local.

## Features

- **Drawing tools** — pen, eraser, text, shapes (arrow, line, rectangle, circle)
- **Select & move** — click any object to select it, drag or nudge it with the arrow keys, delete it
- **Geometric eraser** — erases the exact geometry under the cursor instead of painting over it, so partly
  erased strokes and shapes keep their gaps when you move them later
- **Velocity-sensitive pen** — strokes taper as you draw faster
- **Smart stroke refinement** — two opt-in Draw-tool modes that clean up each stroke as you lift the pen.
  Both leave you with an ordinary stroke, so it still erases and moves like one:
  - **Smart Stroke** (`S`) — snaps a closed stroke to a perfect circle, rectangle or triangle, and smooths
    everything else to remove hand jitter
  - **Smart Stroke 2** (`Shift+S`) — rebuilds any stroke, open or closed, out of exact pieces: straight runs
    become dead-straight lines (pulled onto a 45° step when they are already within 7° of one), curved runs
    become true arcs, and corners stay sharp. Built for letterforms and everyday boxes and arrows
- **Rich text** — 7 fonts, adjustable size, bold / italic; double-click any text to edit it in place
- **Markdown sticky notes** — with the Text tool active, press `N` (or the sticky button in the bottom bar)
  to open a small Markdown editor: pick a pad colour, type, and the note is drawn straight onto the canvas
  with real headings, lists, task boxes, quotes, rules, links, **bold**, *italic* and `code`. It pans, zooms,
  moves, erases and exports like any other object:
  - **Its own font** — pick the family and size in the editor header; the editor is set in that face
    while you type, and clicking **OK** hands the note to the Select tool with its handles ready
  - **Task lists** — `- [ ]` and `- [x]` draw real checkboxes you can **click on the canvas** to tick
    off: the box lifts under the cursor, a click rewrites that one line of the note's source, and it
    undoes like any other edit. A ticked line dims and strikes through, and a list of two or more
    tasks gets its own progress meter
  - **Links** — `[label](url)` and bare `https://…` are underlined on the pad, and open in a new tab
    when you click them with the Select tool
  - **Resizable** — select a note and drag any of its eight handles. It re-wraps to the width you give it
    and keeps the extra height, but never shrinks below the text it holds, so an edit can't clip itself
  - Double-click a note to edit it, or drop a `.md` / `.txt` file anywhere on the page to land its
    contents as a note where you dropped it
- **Infinite canvas** — pan and zoom freely (4%–1000%), with pinch-zoom and touch drawing on tablets
- **Colour picker** — the `+` at the end of the toolbar palette (and of the sticky-note swatches) opens a
  72-colour grid plus a native custom picker. The three most recent colours you mix are kept in both
  palettes and saved with the canvas; a fourth pushes out the oldest
- **Dark / Light mode**
- **Undo / Redo** with full history
- **Auto-save** — the whole canvas (objects, viewport, theme, name, custom colours) is stored in IndexedDB
  and restored automatically after a refresh, tab close, or crash
- **Canvas info card** — name your canvas and see when you started it
- **Paste images** directly from clipboard (Ctrl+V)
- **Export** to PNG or PDF
- **Keyboard shortcuts** for fast workflow

## Usage

Just open `index.html` in any modern browser. That's it.

Run the unit tests (zero dependencies, Node only):

```sh
node tests/geometry.test.js
node tests/markdown.test.js
```

| Shortcut | Action |
|---|---|
| `V` / `D` / `E` / `T` / `P` | Select / Draw / Eraser / Text / Pan |
| `A` / `L` / `R` / `C` | Arrow / Line / Rectangle / Circle |
| `S` / `Shift+S` (draw tool) | Toggle Smart Stroke / Smart Stroke 2 (one at a time) |
| `N` (text tool) | New Markdown sticky note (`Ctrl+Enter` saves it, `Esc` cancels) |
| `Space` + drag, or middle-mouse drag | Pan canvas |
| Scroll, or pinch | Zoom in/out |
| `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) | Undo / Redo |
| `Ctrl+V` | Paste image |
| Double-click text / sticky note | Edit it in place |
| Drag a note handle (select tool) | Resize the note — it re-wraps to the new width |
| Click a task box on a note (select tool) | Tick it off / untick it |
| Click a link on a note (select tool) | Open it in a new tab |
| Drop a `.md` / `.txt` file | Add it as a sticky note at the drop point |
| `←` `→` `↑` `↓` (select tool) | Nudge selection by 1px — hold `Shift` for 10px |
| `Delete` / `Backspace` (select tool) | Delete selection |
| `Esc` | Finish text editing · close the colour picker, a menu, or the note editor |

## Markdown in sticky notes

The parser is deliberately small — it covers what a note needs and nothing more:

| Syntax | Result |
|---|---|
| `# Heading` … `### Heading` | Headings; `####`–`######` render like `###`, and seven hashes is plain text |
| `- item`, `* item`, `+ item` | Bullet list — two spaces of indent nests it, up to 3 levels |
| `- [ ] todo`, `- [x] done` | Task box. Click it on the canvas to tick it off; two or more get a progress meter |
| `1. item`, `1) item` | Numbered list |
| `> quoted` | Blockquote |
| `---`, `***`, `___` | Horizontal rule |
| `**bold**`, `*italic*`, `***both***` | Emphasis, including nested (`**bold with *italic* inside**`) |
| `` `code` `` | Inline code — its contents are never re-parsed |
| `[label](url)`, bare `https://…` | Link. Click it with the Select tool to open it in a new tab |

Two deliberate departures from full Markdown:

- **Underscores are never emphasis.** `snake_case` is far more common in a sketching tool than `_italics_`,
  and silently italicising half an identifier is the worse bug.
- **One source line is one block.** Lines are never joined into paragraphs, so the note keeps the shape you
  typed; a line longer than the pad wraps to its width, with list items hanging under their own first line.

## License

[MIT](LICENSE)
