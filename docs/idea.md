I want to create a confluence like website. Central part is writing
documents. The documents should be written only in djot with syntax highlighting
(no "rendered" HTML output simply plain text djot with highlighting. Crucial,
highlighting should be really fast and precise. What would be a good stack, are
there any existing JS modules that provide for that?


Building a Confluence-like wiki with Djot
Good news: Djot has solid JS tooling, and "plain text with syntax highlighting" is actually much easier than full rendering. Let me walk through the stack.
The core editor decision
For a code-editor-style experience (line numbers, fast incremental highlighting, find/replace, multi-cursor), you want CodeMirror 6. It's the right fit here for several reasons:

Incremental, viewport-only re-highlighting via Lezer (its parser system) — stays fast on documents tens of thousands of lines long
Fully tree-shakable, ~150KB for a typical setup
Built-in support for the things wiki authors expect: search, undo history, autocomplete, keymaps
Works well with collaborative editing (Yjs/Automerge bindings exist)

Monaco is the alternative but it's heavier (~2MB+) and overkill for prose-leaning markup. ProseMirror is the wrong tool — it's for rich-text editing, not plain-text-with-highlighting.
Djot highlighting options
Here's where it gets interesting. There's no off-the-shelf CodeMirror language package for Djot, so you have a few paths:
Option 1 — Write a Lezer grammar for Djot (best long-term). Lezer is CodeMirror 6's parser generator. It produces incremental parse trees, which is what makes highlighting feel instant on every keystroke. You'd write a .grammar file describing Djot's syntax and ship it as your own @codemirror/lang-djot package. This is the most work upfront (a few days) but gives you the precision and speed you specifically asked for. Djot's grammar is more regular than Markdown's, so this is genuinely tractable — easier than writing a Markdown grammar would be.
Option 2 — Use @djot/djot (the official JS parser by John MacFarlane) and bridge it to CodeMirror. The official parser produces an AST you could walk to emit decorations. This is faster to set up but you'd be re-parsing on changes rather than getting Lezer's incremental behavior. Probably fine up to ~5–10k lines, then it'll start to feel laggy.
Option 3 — TextMate grammar via Shiki or vscode-textmate. There's a community Djot TextMate grammar floating around. Shiki gives gorgeous, precise highlighting (it uses the same engine VS Code uses) but it's optimized for static rendering, not live editing — not what you want here.
For your stated priorities (fast + precise), Option 1 is the right answer. Option 2 is the pragmatic MVP if you want to ship sooner and upgrade later.
The full stack I'd suggest
Frontend: React or Svelte + CodeMirror 6 + a Djot Lezer grammar (yours) or @djot/djot (interim).
Backend: whatever you're comfortable with — the documents are just text blobs. PostgreSQL with a documents table (id, space_id, title, content, version, updated_at) and a document_versions table for history gets you 90% of Confluence's data model. Add full-text search via Postgres tsvector or Meilisearch.
Realtime collaboration (if you want it): Yjs has a first-class CodeMirror 6 binding (y-codemirror.next) and works beautifully with plain text. This is the easiest collaborative editing you'll ever set up.
Auth + spaces/permissions: standard stuff — Lucia, Auth.js, or Clerk depending on preference.
A note on "no rendered HTML"
Worth double-checking this with yourself. Confluence users typically want at least a preview pane or a toggle to read the rendered version, even if writing is plain-text-only. @djot/djot can render to HTML in one call (renderHTML(parse(text))) so adding a preview later costs almost nothing — worth keeping the door open architecturally.
Concrete starting point
npm i codemirror @codemirror/state @codemirror/view @codemirror/commands \
      @codemirror/search @codemirror/language @lezer/highlight @djot/djot
Spin up a CodeMirror 6 instance, write a ViewPlugin that runs @djot/djot's parser on doc changes (debounced, ~50ms), walks the AST, and emits Decoration.mark ranges tagged with highlight classes. That's a working prototype in a day. Replace with a Lezer grammar when you want the polish.
Want me to sketch out the Lezer grammar for Djot, or the AST-walker bridge for the MVP path?You said: Sounds good.Sounds good. Assume I have programming background but mostly on the backend side. So walk me through setting up he CodeMirror approach with djot parser, debouncer etc.3:15 PMClaude responded: CodeMirror 6 + Djot: a hands-on walkthroughCodeMirror 6 + Djot: a hands-on walkthrough
I'll assume you know JS basics but not the CodeMirror 6 mental model. CM6 is unusual — it's a strict functional/immutable architecture that trips up most people on first contact. I'll explain the concepts as we hit them.
The mental model (read this first)
CodeMirror 6 has three things you need to understand:
EditorState is an immutable snapshot of the document plus everything about it (selection, undo history, decorations, etc.). You never mutate it. To change anything, you dispatch a transaction and get a new state back.
EditorView is the DOM. It owns a state and renders it. When you dispatch a transaction, the view updates the state and re-renders the changed parts.
Extensions are how you add features. Syntax highlighting, line numbers, keymaps, your custom Djot parser — all extensions. You compose them as an array when creating the state.
For our purposes, the key extension type is a ViewPlugin — a class that gets notified of view updates and can produce decorations (the things that color text).
That's it. Let's build.
Step 1: Project setup
bashmkdir djot-editor && cd djot-editor
npm init -y
npm install codemirror @codemirror/state @codemirror/view \
            @codemirror/commands @codemirror/search @codemirror/language \
            @lezer/highlight @djot/djot
npm install -D vite
Vite is just for a fast dev server with ES modules — no config needed.
index.html:
html<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Djot Editor</title>
    <style>
      body { margin: 0; font-family: system-ui; }
      .cm-editor { height: 100vh; font-size: 14px; }
    </style>
  </head>
  <body>
    <div id="editor"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
src/main.js (minimal editor, no Djot yet):
jsimport { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";

const startDoc = `# Hello Djot

This is *emphasis* and this is _strong_.

- a list
- with items

\`\`\`python
def hello():
    print("hi")
\`\`\`
`;

new EditorView({
  parent: document.getElementById("editor"),
  state: EditorState.create({
    doc: startDoc,
    extensions: [
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ],
  }),
});
Run npx vite and you should have a working plain-text editor at localhost:5173. No highlighting yet — that's next.
Step 2: Understand what we're building
Highlighting in CM6 works through decorations. A decoration is a range (from, to) with a CSS class attached. The view plugin's job is:

Parse the document with @djot/djot
Walk the AST
For each node (heading, emphasis, code span, etc.), compute its character offset range and emit a Decoration.mark with an appropriate class
Return all decorations as a DecorationSet

CM6 takes that set and applies the classes to the right characters. Updates work the same way — re-parse, re-emit, CM6 diffs and re-renders only what changed.
Step 3: The Djot AST shape
Before writing code, you need to know what @djot/djot gives back. A quick exploration:
jsimport { parse } from "@djot/djot";
console.log(JSON.stringify(parse("# Heading\n\n*emph*"), null, 2));
You'll get something like:
json{
  "tag": "doc",
  "children": [
    {
      "tag": "heading",
      "level": 1,
      "children": [{ "tag": "str", "text": "Heading" }],
      "pos": { "start": {...}, "end": {...} }
    },
    ...
  ]
}
The crucial bit: you need source positions, not just nested structure. Pass sourcePositions: true to parse() and every node gets a pos object with start.offset and end.offset — character offsets into the source string. Those map directly to CodeMirror ranges.
Step 4: The view plugin
Here's where the real work happens. Create src/djot-highlight.js:
jsimport { parse } from "@djot/djot";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Map Djot AST tags to CSS class names.
// Add more as you want finer-grained styling.
const TAG_TO_CLASS = {
  heading: "djot-heading",
  emph: "djot-emph",
  strong: "djot-strong",
  link: "djot-link",
  url: "djot-url",
  image: "djot-image",
  code: "djot-code",
  verbatim: "djot-verbatim",
  code_block: "djot-code-block",
  blockquote: "djot-blockquote",
  list: "djot-list",
  list_item: "djot-list-item",
  thematic_break: "djot-hr",
  raw_inline: "djot-raw",
  raw_block: "djot-raw",
  math: "djot-math",
  footnote_reference: "djot-footnote-ref",
};

// Walk the AST and collect [from, to, className] ranges.
// Recursion is fine here — Djot ASTs aren't deep.
function collectRanges(node, out) {
  if (node.pos && TAG_TO_CLASS[node.tag]) {
    const from = node.pos.start.offset;
    const to = node.pos.end.offset;
    if (to > from) {
      out.push({ from, to, cls: TAG_TO_CLASS[node.tag] });
    }
  }
  if (node.children) {
    for (const child of node.children) collectRanges(child, out);
  }
}

function buildDecorations(doc) {
  const text = doc.toString();
  let ast;
  try {
    ast = parse(text, { sourcePositions: true });
  } catch (e) {
    // Parser hiccup on partial input — return empty, try again next tick.
    return Decoration.none;
  }

  const ranges = [];
  collectRanges(ast, ranges);

  // CM6 requires ranges in sorted order (by `from`, then by length).
  // Outer-first traversal already gives this for nested AST nodes,
  // but sort defensively in case sibling order isn't strictly source order.
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
      this.scheduled = null;
    }

    update(update) {
      if (!update.docChanged) return;

      // Debounce: cancel pending re-parse, schedule a new one.
      if (this.scheduled) clearTimeout(this.scheduled);
      this.scheduled = setTimeout(() => {
        this.scheduled = null;
        // We need to dispatch a no-op transaction to trigger re-render
        // with the new decorations. But there's a cleaner way: just
        // recompute and request a measure. See `update` rewrite below.
        this.decorations = buildDecorations(update.view.state.doc);
        update.view.update([]); // force re-render
      }, 80);
    }

    destroy() {
      if (this.scheduled) clearTimeout(this.scheduled);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
There's a subtlety with debouncing inside a ViewPlugin that's worth flagging — update.view.update([]) is not the standard pattern. The cleaner approach is to use CM6's built-in mechanism: a StateField that holds decorations, with the parse triggered by an effect. But for a starter, the simpler and more idiomatic version is to not debounce at all and just parse synchronously on every update. Djot is fast — for documents under ~50KB you won't notice.
Let me give you the cleaner non-debounced version, then show how to add debouncing properly when you actually need it:
jsimport { parse } from "@djot/djot";
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
Now wire it into main.js:
jsimport { djotHighlight } from "./djot-highlight.js";

// ...inside extensions array:
extensions: [
  lineNumbers(),
  history(),
  djotHighlight,  // <-- add this
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
],
And add some CSS to index.html so you can see the highlighting actually working:
css.djot-heading      { color: #c026d3; font-weight: 700; }
.djot-emph         { color: #2563eb; font-style: italic; }
.djot-strong       { color: #2563eb; font-weight: 700; }
.djot-link         { color: #0891b2; text-decoration: underline; }
.djot-url          { color: #0891b2; }
.djot-code,
.djot-verbatim     { background: #f3f4f6; color: #be185d; padding: 0 2px; border-radius: 2px; font-family: ui-monospace, monospace; }
.djot-code-block   { background: #f9fafb; color: #334155; }
.djot-blockquote   { color: #6b7280; font-style: italic; }
.djot-hr           { color: #9ca3af; }
.djot-raw          { color: #ea580c; }
.djot-math         { color: #7c3aed; }
Reload. You should see colored emphasis, headings, code spans, etc.
Step 5: When (and how) to add debouncing
The version above re-parses synchronously on every keystroke. Measure before optimizing — open Chrome DevTools, paste in a 5,000-line document, and watch the frame times while typing. If you're under 16ms per keystroke, you're done.
If you do hit a wall (very large docs, or you add expensive post-processing later), the right pattern is a StateField + StateEffect:
jsimport { StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";

const setDecorations = StateEffect.define();

const djotDecorationField = StateField.define({
  create: (state) => buildDecorations(state.doc),
  update(decos, tr) {
    // Map existing decorations through the change so they don't drift
    // until fresh ones arrive from the debounced parse.
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDecorations)) decos = e.value;
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const djotDebouncedParse = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.timer = null;
    }
    update(update) {
      if (!update.docChanged) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        const decos = buildDecorations(this.view.state.doc);
        this.view.dispatch({ effects: setDecorations.of(decos) });
      }, 80);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  }
);

export const djotHighlight = [djotDecorationField, djotDebouncedParse];
The key insight: the StateField holds the decorations and maps them through changes so they shift correctly while the user types. The ViewPlugin only schedules the re-parse. When the parse finishes, it dispatches a setDecorations effect to swap in the fresh set. The user never sees stale or misaligned highlighting.
Don't add this until you measure a problem. The simple version is enough for most documents.
Step 6: Where this leaves you
You now have:

a CM6 editor with line numbers, undo, search, the standard keymap
live Djot syntax highlighting via the official parser
a path to debounce when documents grow

Things you'd add next, in roughly this order:

Persist content — view.state.doc.toString() gives you the text; ship it to your backend on a debounced save.
Code-fence inner highlighting — when you hit a code_block with a lang attribute, run that range through Lezer's language packs (@codemirror/lang-python, etc.) for highlighting inside the fence. This is more involved; it's a separate ViewPlugin that finds code blocks and applies nested decorations.
Theme — wrap your CSS in EditorView.theme({...}) instead of global CSS, so you can swap light/dark.
Yjs collaboration — y-codemirror.next plugs in as one more extension. Almost free.

Want me to walk through any of those, or sketch the StateField pattern in more detail with a concrete trace of what happens on a keystroke?You said: Give me an id for this conversation so I can pick up in the CLI.Give me an id for this conversation so I can pick up in the CLI. Also tell me how to attach in the CLI.3:55 PMClaude responded: I don't have a way to generate or expose a conversation ID for you to pick up in the CLI — that's not something I have access to from inside the chat.I don't have a way to generate or expose a conversation ID for you to pick up in the CLI — that's not something I have access to from inside the chat.
