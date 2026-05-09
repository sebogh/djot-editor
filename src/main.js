import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { djotHighlight } from "./djot-highlight.js";

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
      djotHighlight,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ],
  }),
});
