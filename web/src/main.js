import "@picocss/pico/css/pico.min.css";
import "./styles.css";

import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { parse, renderHTML } from "@djot/djot";
import DOMPurify from "dompurify";
import { djotHighlight } from "./djot-highlight.js";
import { createShare, loadShare } from "./share.js";
import * as auth from "./auth.js";

const STORAGE_DOC = "zorto:doc";
const STORAGE_TITLE = "zorto:title";

function loadStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function saveStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* quota or unavailable */ }
}

const initialDoc = loadStorage(STORAGE_DOC) ?? "";
const initialTitle = loadStorage(STORAGE_TITLE) ?? "";

const FromShareLoad = Annotation.define();
let linkedToShare = false;

function forkFromShare() {
  if (!linkedToShare) return;
  linkedToShare = false;
  window.history.replaceState(null, "", location.pathname + location.search);
  saveStorage(STORAGE_TITLE, titleInput.value);
  saveStorage(STORAGE_DOC, view.state.doc.toString());
}

const previewEl = document.getElementById("preview");
const previewToggle = document.getElementById("toggle-preview");
const wrapToggle = document.getElementById("toggle-wrap");
const themeSelect = document.getElementById("theme-select");
const titleInput = document.getElementById("title");
const downloadBtn = document.getElementById("download");
const shareBtn = document.getElementById("share");
const clearBtn = document.getElementById("clear");

titleInput.value = initialTitle;
titleInput.addEventListener("input", () => {
  if (linkedToShare) forkFromShare();
  saveStorage(STORAGE_TITLE, titleInput.value);
});

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

let docSaveTimer = null;
const persistDoc = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (update.transactions.some((tr) => tr.annotation(FromShareLoad))) return;
  if (linkedToShare) forkFromShare();
  if (docSaveTimer) clearTimeout(docSaveTimer);
  docSaveTimer = setTimeout(() => {
    saveStorage(STORAGE_DOC, update.state.doc.toString());
  }, 300);
});

const editorTheme = EditorView.theme({
  ".cm-content": { padding: "16px 21px" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "none",
    background: "var(--pico-color)",
    width: "1ch",
    opacity: "0.45",
  },
});

const wrapCompartment = new Compartment();

const view = new EditorView({
  parent: document.getElementById("editor"),
  state: EditorState.create({
    doc: initialDoc,
    extensions: [
      history(),
      drawSelection(),
      djotHighlight,
      previewSync,
      persistDoc,
      editorTheme,
      wrapCompartment.of(wrapToggle.checked ? EditorView.lineWrapping : []),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ],
  }),
});

view.focus();

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

clearBtn.addEventListener("click", () => {
  linkedToShare = false;
  titleInput.value = "";
  saveStorage(STORAGE_TITLE, "");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: "" },
  });
  saveStorage(STORAGE_DOC, "");
  window.history.replaceState(null, "", location.pathname + location.search);
});

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
    linkedToShare = true;
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
    linkedToShare = true;
    titleInput.value = title;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: FromShareLoad.of(true),
    });
  } catch (e) {
    console.error("load shared doc failed", e);
  }
}

const signinBtn = document.getElementById("auth-signin");
const authMenu = document.getElementById("auth-menu");
const authSummary = document.getElementById("auth-summary");
const logoutAction = document.getElementById("auth-logout");

async function refreshAuthUI() {
  if (!auth.isEnabled()) return;
  const signedIn = await auth.isAuthenticated();
  if (signedIn) {
    signinBtn.hidden = true;
    authMenu.hidden = false;
    const user = await auth.getUser();
    const name = user?.name || user?.email || "Account";
    const src = user?.picture || await auth.identiconDataUrl(user?.sub || name);
    authSummary.replaceChildren();
    authSummary.title = name;
    authSummary.setAttribute("aria-label", name);
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = src;
    img.alt = "";
    authSummary.appendChild(img);
  } else {
    authMenu.hidden = true;
    authMenu.open = false;
    signinBtn.hidden = false;
  }
}

signinBtn.addEventListener("click", () => auth.login());
logoutAction.addEventListener("click", (e) => {
  e.preventDefault();
  authMenu.open = false;
  auth.logout();
});

document.addEventListener("click", (e) => {
  if (authMenu.open && !authMenu.contains(e.target)) authMenu.open = false;
});

async function applyServerConfig() {
  try {
    const res = await fetch("./api/config");
    if (!res.ok) return;
    const config = await res.json();
    if (config.shareEnabled === false) {
      shareBtn.disabled = true;
      shareBtn.title = "Sharing is disabled on this server";
    }
    if (config.authEnabled) {
      await auth.initAuth(config);
      await refreshAuthUI();
    }
  } catch (e) {
    console.error("applyServerConfig failed", e);
  }
}

applyServerConfig();
loadFromHash();
