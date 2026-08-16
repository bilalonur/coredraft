/* ============================================================
   coredraft — Markdown parser unit tests
   ------------------------------------------------------------
   Zero-dependency test runner: `node tests/markdown.test.js`
   Exits non-zero on any failure. Covers the pure helpers in
   markdown.js (inline emphasis and block classification).
   ============================================================ */

const { parseInlineMarkdown, parseMarkdownBlocks } = require('../markdown.js');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; } else {
    failed++;
    console.error(`FAIL ${label}: expected ${b}, got ${a}`);
  }
}

function assertTrue(cond, label = '') {
  if (cond) { passed++; } else { failed++; console.error(`FAIL ${label}`); }
}

// Compact view of a chunk list: 'text' plain, 'text!' bold, 'text/' italic,
// 'text`' code, 'text→url' link — keeps the expectations below readable.
function sketch(chunks) {
  return chunks.map((c) => c.text + (c.bold ? '!' : '') + (c.italic ? '/' : '') +
    (c.code ? '`' : '') + (c.link ? '→' + c.link : ''));
}

// ── Inline emphasis ───────────────────────────────────────

assertEqual(sketch(parseInlineMarkdown('plain text')), ['plain text'], 'plain text is one chunk');
assertEqual(sketch(parseInlineMarkdown('a **b** c')), ['a ', 'b!', ' c'], 'bold splits the line');
assertEqual(sketch(parseInlineMarkdown('a *b* c')), ['a ', 'b/', ' c'], 'italic splits the line');
assertEqual(sketch(parseInlineMarkdown('***both***')), ['both!/'], 'triple marker is bold + italic');
assertEqual(sketch(parseInlineMarkdown('a `x=1` b')), ['a ', 'x=1`', ' b'], 'backticks make a code chunk');

// Nesting: the inner marker keeps the outer style
assertEqual(sketch(parseInlineMarkdown('**bold with *italic* inside**')),
  ['bold with !', 'italic!/', ' inside!'], 'italic nested inside bold keeps both');

// Code spans are literal — markers inside them are not emphasis
assertEqual(sketch(parseInlineMarkdown('`**not bold**`')), ['**not bold**`'], 'code span content is literal');

// Unbalanced / spaced markers stay as plain text
assertEqual(sketch(parseInlineMarkdown('2 * 3 * 4')), ['2 * 3 * 4'], 'spaced asterisks are arithmetic');
assertEqual(sketch(parseInlineMarkdown('unclosed **bold')), ['unclosed **bold'], 'unclosed marker stays literal');
assertEqual(sketch(parseInlineMarkdown('snake_case_name')), ['snake_case_name'], 'underscores are never emphasis');

// Adjacent same-style runs are merged, empty ones dropped
assertEqual(parseInlineMarkdown('').length, 0, 'empty string yields no chunks');
assertEqual(parseInlineMarkdown(null).length, 0, 'null yields no chunks');
assertEqual(sketch(parseInlineMarkdown('**a****b**')), ['ab!'], 'touching bold runs merge');

// Multiple markers on one line
assertEqual(sketch(parseInlineMarkdown('**a** and *b* and `c`')),
  ['a!', ' and ', 'b/', ' and ', 'c`'], 'three markers on one line');

// ── Links ─────────────────────────────────────────────────

assertEqual(sketch(parseInlineMarkdown('see [the docs](https://ex.com/a) now')),
  ['see ', 'the docs→https://ex.com/a', ' now'], 'a labelled link carries its target');
assertEqual(sketch(parseInlineMarkdown('[**bold** link](https://ex.com)')),
  ['bold!→https://ex.com', ' link→https://ex.com'], 'a link label keeps its own emphasis');
assertEqual(sketch(parseInlineMarkdown('[](https://ex.com)')),
  ['https://ex.com→https://ex.com'], 'an empty label falls back to the target');
assertEqual(sketch(parseInlineMarkdown('go to https://ex.com/x now')),
  ['go to ', 'https://ex.com/x→https://ex.com/x', ' now'], 'a bare url becomes a link');
assertEqual(sketch(parseInlineMarkdown('see https://ex.com/x.')),
  ['see ', 'https://ex.com/x→https://ex.com/x', '.'], 'a bare url gives back trailing punctuation');
assertEqual(sketch(parseInlineMarkdown('[a](https://ex.com/1) and [b](https://ex.com/2)')),
  ['a→https://ex.com/1', ' and ', 'b→https://ex.com/2'], 'two links on one line stay apart');
assertEqual(sketch(parseInlineMarkdown('`https://ex.com`')),
  ['https://ex.com`'], 'a url inside code is not linked');
assertEqual(sketch(parseInlineMarkdown('[not a link] (spaced)')),
  ['[not a link] (spaced)'], 'brackets need the parens attached');
assertEqual(sketch(parseInlineMarkdown('plain'))[0], 'plain', 'ordinary text carries no link');
assertTrue(parseInlineMarkdown('plain')[0].link === null, 'ordinary text has a null link');

// ── Block classification ──────────────────────────────────

const blocks = parseMarkdownBlocks([
  '# Title',
  '',
  'Some **text**.',
  '- one',
  '  - nested',
  '1. first',
  '2) second',
  '> quoted',
  '---'
].join('\n'));

assertEqual(blocks.map((b) => b.kind),
  ['heading', 'blank', 'text', 'bullet', 'bullet', 'ordered', 'ordered', 'quote', 'rule'],
  'every line is classified');

assertEqual(blocks[0].level, 1, 'single hash is level 1');
assertEqual(sketch(blocks[0].chunks), ['Title'], 'heading text drops the marker');
assertEqual(sketch(blocks[2].chunks), ['Some ', 'text!', '.'], 'paragraph keeps inline styles');
assertEqual(blocks[3].indent, 0, 'top-level bullet has indent 0');
assertEqual(blocks[4].indent, 1, 'two-space bullet is one level deep');
assertEqual(blocks[4].marker, '•', 'bullets carry a bullet marker');
assertEqual(blocks[5].marker, '1.', 'ordered marker keeps its number');
assertEqual(blocks[6].marker, '2.', 'a paren-style number normalises to a dot');
assertEqual(sketch(blocks[7].chunks), ['quoted'], 'quote text drops the marker');
assertEqual(blocks[8].chunks.length, 0, 'a rule carries no text');

// ── Task lists ────────────────────────────────────────────

const tasks = parseMarkdownBlocks([
  '- [ ] open',
  '- [x] done',
  '- [X] also done',
  '  - [ ] nested',
  '- [ ]',
  '- [y] not a task',
  '- plain bullet'
].join('\n'));

assertEqual(tasks.map((b) => b.kind),
  ['task', 'task', 'task', 'task', 'task', 'bullet', 'bullet'], 'checkboxes make tasks, nothing else does');
assertEqual(tasks.map((b) => b.checked), [false, true, true, false, false, undefined, undefined],
  'the checked state is read from the box');
assertEqual(sketch(tasks[0].chunks), ['open'], 'task text drops the checkbox');
assertEqual(tasks[3].indent, 1, 'a nested task keeps its depth');
assertEqual(tasks[4].chunks.length, 0, 'an empty task is still a task');
assertEqual(sketch(tasks[5].chunks), ['[y] not a task'], 'an unknown box stays literal text');
assertEqual(sketch(parseMarkdownBlocks('- [x] **ship** [it](https://ex.com)')[0].chunks),
  ['ship!', ' ', 'it→https://ex.com'], 'a task keeps inline styles and links');

// Every block knows the source line it came from — this is what lets a click
// on a rendered checkbox rewrite exactly the right line of the source.
assertEqual(tasks.map((b) => b.line), [0, 1, 2, 3, 4, 5, 6], 'blocks carry their source line');
assertEqual(parseMarkdownBlocks('a\n\n- [ ] t').map((b) => b.line), [0, 1, 2],
  'blank lines are counted in the numbering');

// Heading levels clamp at 3 so a deep heading never dwarfs the note
assertEqual(parseMarkdownBlocks('###### deep')[0].level, 3, 'heading level clamps to 3');
assertEqual(parseMarkdownBlocks('####### seven')[0].kind, 'text', 'seven hashes is not a heading');
assertEqual(parseMarkdownBlocks('#nospace')[0].kind, 'text', 'a hash needs a space to be a heading');

// Rules in their several spellings — and the things that only look like one
assertEqual(parseMarkdownBlocks('***')[0].kind, 'rule', 'three asterisks are a rule');
assertEqual(parseMarkdownBlocks('- - -')[0].kind, 'rule', 'spaced dashes are a rule, not a bullet');
assertEqual(parseMarkdownBlocks('___')[0].kind, 'rule', 'three underscores are a rule');
assertEqual(parseMarkdownBlocks('--')[0].kind, 'text', 'two dashes are not a rule');
assertEqual(parseMarkdownBlocks('-item')[0].kind, 'text', 'a dash needs a space to be a bullet');

// Nesting depth is capped, and tabs count as one level
assertEqual(parseMarkdownBlocks('        - deep')[0].indent, 3, 'list depth caps at 3');
assertEqual(parseMarkdownBlocks('\t- tabbed')[0].indent, 1, 'a tab is one nesting level');

// Whole-document shape
assertEqual(parseMarkdownBlocks('').length, 1, 'empty document is one blank block');
assertEqual(parseMarkdownBlocks(null).length, 0, 'null document yields no blocks');
assertEqual(parseMarkdownBlocks('a\nb\nc').length, 3, 'one block per source line');
assertTrue(parseMarkdownBlocks('a\nb').every((b) => Array.isArray(b.chunks)), 'every block has chunks');

// Trailing whitespace is trimmed rather than measured into the layout
assertEqual(sketch(parseMarkdownBlocks('hello   ')[0].chunks), ['hello'], 'trailing spaces are trimmed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
