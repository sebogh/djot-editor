import { parse } from "@djot/djot";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

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

function collectRanges(node, out) {
  if (node.pos && TAG_TO_CLASS[node.tag]) {
    const from = node.pos.start.offset;
    const to = node.pos.end.offset;
    if (to > from) out.push({ from, to, cls: TAG_TO_CLASS[node.tag] });
  }
  if (node.children) for (const child of node.children) collectRanges(child, out);
}

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