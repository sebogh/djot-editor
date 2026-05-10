/**
 * Syntax highlighter for Djot, exposed as a CodeMirror 6 ViewPlugin.
 *
 * On every doc change we re-parse the buffer with `@djot/djot`'s position-
 * tracking parser, walk the AST, and emit a CodeMirror Decoration with the
 * matching class for every node tag in `TAG_TO_CLASS`. The classes are
 * styled in styles.css.
 *
 * Re-parsing the whole document on every keystroke is wasteful in theory
 * but fine in practice — Djot's parser is fast and the editor caps out at
 * doc sizes well below where it would matter. If that ever changes the
 * obvious upgrade is incremental parsing keyed on changed line ranges.
 */

import { parse } from "@djot/djot";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/**
 * Map from Djot AST tag names to the CSS class applied to the corresponding
 * source range. Tags missing from this map produce no decoration (the source
 * shows in the default editor colour).
 */
const TAG_TO_CLASS = {
  heading: "djot-heading",
  emph: "djot-emph",
  strong: "djot-strong",
  link: "djot-link",
  url: "djot-url",
  code: "djot-code",
  verbatim: "djot-verbatim",
  code_block: "djot-code-block",
  blockquote: "djot-blockquote",
  thematic_break: "djot-hr",
  raw_inline: "djot-raw",
  math: "djot-math",
};

/**
 * Depth-first walk that pushes one `{from, to, cls}` record per relevant
 * AST node into `out`. Mutates `out` rather than returning to avoid
 * allocation on deeply nested documents.
 */
function collectRanges(node, out) {
  if (node.pos && TAG_TO_CLASS[node.tag]) {
    const from = node.pos.start.offset;
    const to = node.pos.end.offset;
    if (to > from) out.push({ from, to, cls: TAG_TO_CLASS[node.tag] });
  }
  if (node.children) for (const child of node.children) collectRanges(child, out);
}

/**
 * Parse `doc` and turn the AST into a CodeMirror DecorationSet. On parse
 * failure (transient mid-edit), returns `Decoration.none` so the previous
 * decorations stay until the next successful parse.
 *
 * Sort order matters to RangeSetBuilder: ranges must be added in increasing
 * `from`, and for equal `from`, decreasing `to` (outer ranges first).
 */
function buildDecorations(doc) {
  const text = doc.toString();
  let ast;
  try {
    ast = parse(text, { sourcePositions: true });
  } catch {
    return Decoration.none;
  }

  const ranges = [];
  collectRanges(ast, ranges);
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);

  const builder = new RangeSetBuilder();
  for (const { from, to, cls } of ranges) {
    builder.add(from, to, Decoration.mark({ class: cls }));
  }
  return builder.finish();
}

/**
 * The CodeMirror extension to add to the editor's extensions array. Holds
 * the current decoration set on `this.decorations` and rebuilds it on every
 * doc change.
 */
export const djotHighlight = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view.state.doc);
    }
    update(update) {
      if (update.docChanged) {
        this.decorations = buildDecorations(update.state.doc);
      }
    }
  },
  { decorations: (v) => v.decorations }
);