/* ============================================================
   coredraft — minimal Markdown parser
   ------------------------------------------------------------
   Zero dependencies, no DOM access. Turns raw Markdown into a
   flat list of block descriptors whose text is already split
   into styled chunks, ready for a canvas renderer to draw with
   ctx.font / ctx.fillText.

   Deliberately small. It supports exactly what a sticky note
   needs and nothing else:

     # .. ###      headings (deeper levels clamp to 3)
     - / * / +     bullet list (two-space indent = nesting)
     - [ ] / - [x] task list
     1. / 1)       ordered list
     >             blockquote
     --- / ***     horizontal rule
     **bold**  *italic*  ***both***  `code`
     [label](url)  and bare http(s) links

   Underscores are NOT emphasis markers: snake_case identifiers
   are far more common in a sketching tool than _italics_, and
   silently italicising half a variable name is the worse bug.

   Loaded as a classic script (globals) so the app keeps working
   when opened via file://, and mirrored to module.exports for
   Node-based unit tests.
   ============================================================ */

(function (global) {
  'use strict';

  // One pass over a line of inline markup. The capture groups are ordered
  // longest-marker-first so ***both*** is not eaten by the **bold** rule, and
  // [label](url) is matched before the bare-URL rule so a link's own target is
  // never picked up twice. Each emphasis body must start and end on a
  // non-space character, which keeps arithmetic like "2 * 3 * 4" from turning
  // into emphasis. The trailing `??` matters: without it the optional tail is
  // entered greedily and "**a****b**" swallows a marker into the first body.
  //
  // Groups: 1 label, 2 url · 3 *** · 4 ** · 5 * · 6 `code` · 7 bare url
  const INLINE_PATTERN = /\[([^\]\n]*)\]\(([^()\s]+)\)|\*\*\*(\S(?:.*?\S)??)\*\*\*|\*\*(\S(?:.*?\S)??)\*\*|\*(\S(?:.*?\S)??)\*|`([^`]+?)`|(https?:\/\/[^\s<>()[\]]+)/g;

  // A bare URL that ends a sentence should not swallow the punctuation.
  const URL_TRAILING = /[.,;:!?'"]+$/;

  const MAX_HEADING_LEVEL = 3;   // #### and deeper render like ###
  const MAX_LIST_DEPTH = 3;      // deeper indents stop adding offset
  const INDENT_UNIT = 2;         // spaces per nesting level

  // Adjacent chunks that carry the same styling are joined so the renderer
  // measures and draws one run instead of several touching ones.
  function mergeChunks(chunks) {
    const out = [];
    for (const chunk of chunks) {
      if (!chunk.text) continue;
      const last = out[out.length - 1];
      if (last && last.bold === chunk.bold && last.italic === chunk.italic &&
          last.code === chunk.code && last.link === chunk.link) {
        last.text += chunk.text;
      } else {
        out.push({
          text: chunk.text,
          bold: chunk.bold,
          italic: chunk.italic,
          code: chunk.code,
          link: chunk.link
        });
      }
    }
    return out;
  }

  // Walk one span of text, recursing into every marker body so nested
  // emphasis (**bold with *italic* inside**) keeps both styles. Code spans
  // are literal: their contents are never re-parsed.
  function parseInlineStyled(text, bold, italic, link) {
    // A fresh regex per call — recursion would otherwise share lastIndex.
    const pattern = new RegExp(INLINE_PATTERN.source, 'g');
    const out = [];
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) {
        out.push({ text: text.slice(last, match.index), bold, italic, code: false, link });
      }
      if (match[2] !== undefined) {
        // [label](url) — the label keeps its own emphasis, and an empty label
        // falls back to showing the target itself.
        const label = match[1] || match[2];
        out.push.apply(out, parseInlineStyled(label, bold, italic, match[2]));
      } else if (match[3] !== undefined) {
        out.push.apply(out, parseInlineStyled(match[3], true, true, link));
      } else if (match[4] !== undefined) {
        out.push.apply(out, parseInlineStyled(match[4], true, italic, link));
      } else if (match[5] !== undefined) {
        out.push.apply(out, parseInlineStyled(match[5], bold, true, link));
      } else if (match[6] !== undefined) {
        out.push({ text: match[6], bold, italic, code: true, link });
      } else {
        // Bare URL. Trailing sentence punctuation is handed back to the text.
        const url = match[7].replace(URL_TRAILING, '');
        out.push({ text: url, bold, italic, code: false, link: link || url });
        pattern.lastIndex = match.index + url.length;
      }
      last = pattern.lastIndex;
    }
    if (last < text.length) {
      out.push({ text: text.slice(last), bold, italic, code: false, link });
    }
    return out;
  }

  // Split one line of inline markup into styled chunks:
  //   [{ text, bold, italic, code, link }, ...]
  // link is the target URL, or null for ordinary text.
  function parseInlineMarkdown(text) {
    if (text === null || text === undefined) return [];
    return mergeChunks(parseInlineStyled(String(text), false, false, null));
  }

  // Leading whitespace, in nesting levels. Tabs count as one full level.
  function indentLevel(whitespace) {
    let spaces = 0;
    for (const ch of whitespace) spaces += ch === '\t' ? INDENT_UNIT : 1;
    return Math.min(MAX_LIST_DEPTH, Math.floor(spaces / INDENT_UNIT));
  }

  // Parse a whole Markdown document into block descriptors, one per source
  // line. Every block carries { kind, line, indent, chunks }; some carry extra.
  // `line` is the 0-based source line the block came from, which is what lets
  // a renderer map something it drew — a checkbox, say — back to the text that
  // produced it, and rewrite exactly that line.
  //
  //   heading  level 1..3
  //   bullet   marker '•'
  //   task     checked true/false — the renderer draws the box
  //   ordered  marker '1.'
  //   quote    — text is styled by the renderer, not here
  //   rule     — no text
  //   blank    — vertical space only
  //   text     — everything else
  function parseMarkdownBlocks(rawText) {
    if (rawText === null || rawText === undefined) return [];
    const lines = String(rawText).split('\n');
    const blocks = [];

    lines.forEach((rawLine, lineIndex) => {
      const line = rawLine.replace(/\s+$/, '');

      if (!line.trim()) {
        blocks.push({ kind: 'blank', line: lineIndex, indent: 0, chunks: [] });
        return;
      }

      // Rules are checked before lists: '- - -' is a rule, not three bullets.
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        blocks.push({ kind: 'rule', line: lineIndex, indent: 0, chunks: [] });
        return;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (heading) {
        blocks.push({
          kind: 'heading',
          line: lineIndex,
          level: Math.min(MAX_HEADING_LEVEL, heading[1].length),
          indent: 0,
          chunks: parseInlineMarkdown(heading[2])
        });
        return;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        blocks.push({ kind: 'quote', line: lineIndex, indent: 0, chunks: parseInlineMarkdown(quote[1]) });
        return;
      }

      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (bullet) {
        // A task is a bullet whose content opens with a checkbox.
        const task = bullet[2].match(/^\[([ xX])\]\s*(.*)$/);
        if (task) {
          blocks.push({
            kind: 'task',
            line: lineIndex,
            indent: indentLevel(bullet[1]),
            checked: task[1] !== ' ',
            chunks: parseInlineMarkdown(task[2])
          });
          return;
        }
        blocks.push({
          kind: 'bullet',
          line: lineIndex,
          indent: indentLevel(bullet[1]),
          marker: '•',
          chunks: parseInlineMarkdown(bullet[2])
        });
        return;
      }

      const ordered = line.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/);
      if (ordered) {
        blocks.push({
          kind: 'ordered',
          line: lineIndex,
          indent: indentLevel(ordered[1]),
          marker: ordered[2] + '.',
          chunks: parseInlineMarkdown(ordered[3])
        });
        return;
      }

      blocks.push({ kind: 'text', line: lineIndex, indent: 0, chunks: parseInlineMarkdown(line) });
    });

    return blocks;
  }

  // Export for both browser (globals) and Node (unit tests).
  const api = {
    parseInlineMarkdown,
    parseMarkdownBlocks
  };
  Object.keys(api).forEach((name) => { global[name] = api[name]; });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
