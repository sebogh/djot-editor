import "@picocss/pico/css/pico.min.css";
import "./styles.css";

import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { parse, renderHTML } from "@djot/djot";
import DOMPurify from "dompurify";
import { djotHighlight } from "./djot-highlight.js";
import { createShare, loadShare } from "./share.js";

const startDoc = `# Hello Djot

This is *emphasis* and this is _strong_.

- a list
- with items

\`\`\`python
def hello():
    print("hi")
\`\`\`
`;

const previewEl = document.getElementById("preview");
const previewToggle = document.getElementById("toggle-preview");
const wrapToggle = document.getElementById("toggle-wrap");
const themeSelect = document.getElementById("theme-select");
const titleInput = document.getElementById("title");
const downloadBtn = document.getElementById("download");
const shareBtn = document.getElementById("share");

function renderPreview(text) {
  try {
    previewEl.innerHTML = DOMPurify.sanitize(renderHTML(parse(text)));
  } catch {
    /* leave previous render in place on transient parse errors */
  }
}

const previewSync = EditorView.updateListener.of((update) => {
  if (update.docChanged && !previewEl.hidden) {
    renderPreview(update.state.doc.toString());
  }
});

const editorTheme = EditorView.theme({
  ".cm-content": { padding: "16px 21px" },
});

const wrapCompartment = new Compartment();

const view = new EditorView({
  parent: document.getElementById("editor"),
  state: EditorState.create({
    doc: startDoc,
    extensions: [
      history(),
      djotHighlight,
      previewSync,
      editorTheme,
      wrapCompartment.of(wrapToggle.checked ? EditorView.lineWrapping : []),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ],
  }),
});

wrapToggle.addEventListener("change", () => {
  view.dispatch({
    effects: wrapCompartment.reconfigure(
      wrapToggle.checked ? EditorView.lineWrapping : []
    ),
  });
});

previewToggle.addEventListener("change", () => {
  if (previewToggle.checked) {
    previewEl.hidden = false;
    renderPreview(view.state.doc.toString());
  } else {
    previewEl.hidden = true;
  }
  view.requestMeasure();
});

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

const savedTheme = localStorage.getItem("theme") || "system";
themeSelect.value = savedTheme;
applyTheme(savedTheme);

themeSelect.addEventListener("change", () => {
  localStorage.setItem("theme", themeSelect.value);
  applyTheme(themeSelect.value);
});

function sanitizeFilename(title) {
  const cleaned = (title || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/^-+|-+$/g, "");
  return cleaned || "untitled";
}

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([view.state.doc.toString()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(titleInput.value)}.dj`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

function flashButton(btn, label, ms = 1500) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, ms);
}

shareBtn.addEventListener("click", async () => {
  const original = shareBtn.textContent;
  shareBtn.disabled = true;
  shareBtn.textContent = "Sharing…";
  try {
    const payload = JSON.stringify({
      title: titleInput.value,
      content: view.state.doc.toString(),
    });
    const { id, keyB64 } = await createShare(payload);
    const url = new URL(location.href);
    url.hash = `s=${id}&k=${keyB64}`;
    window.history.replaceState(null, "", url.toString());
    await navigator.clipboard.writeText(url.toString());
    shareBtn.textContent = original;
    shareBtn.disabled = false;
    flashButton(shareBtn, "Copied!");
  } catch (e) {
    console.error("share failed", e);
    shareBtn.textContent = original;
    shareBtn.disabled = false;
    flashButton(shareBtn, "Failed");
  }
});

async function loadFromHash() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("s");
  const keyB64 = params.get("k");
  if (!id || !keyB64) return;
  try {
    const plaintext = await loadShare(id, keyB64);
    const { title = "", content = "" } = JSON.parse(plaintext);
    titleInput.value = title;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
    window.history.replaceState(null, "", location.pathname + location.search);
  } catch (e) {
    console.error("load shared doc failed", e);
  }
}

loadFromHash();
