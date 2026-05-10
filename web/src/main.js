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

// Working state and UI settings now live server-side in /api/state for signed-in
// users; for signed-out users nothing is persisted across reloads. Drop legacy
// localStorage keys so old browsers don't carry stale drafts.
try {
  localStorage.removeItem("zorto:doc");
  localStorage.removeItem("zorto:title");
  localStorage.removeItem("theme");
} catch { /* unavailable */ }

const SETTINGS_DEFAULTS = Object.freeze({
  theme: "system",
  wrap: true,
  preview: false,
});

const FromShareLoad = Annotation.define();
const FromStateLoad = Annotation.define();

let linkedToShare = false;
let loadingState = false; // suppress saves while populating UI from /api/state
let saveTimer = null;
let serverShareEnabled = false;

const previewEl = document.getElementById("preview");
const previewToggle = document.getElementById("toggle-preview");
const wrapToggle = document.getElementById("toggle-wrap");
const themeSelect = document.getElementById("theme-select");
const titleInput = document.getElementById("title");
const downloadBtn = document.getElementById("download");
const shareBtn = document.getElementById("share");
const clearBtn = document.getElementById("clear");
const signinBtn = document.getElementById("auth-signin");
const authMenu = document.getElementById("auth-menu");
const authSummary = document.getElementById("auth-summary");
const logoutAction = document.getElementById("auth-logout");

themeSelect.value = SETTINGS_DEFAULTS.theme;
wrapToggle.checked = SETTINGS_DEFAULTS.wrap;
previewToggle.checked = SETTINGS_DEFAULTS.preview;
applyTheme(SETTINGS_DEFAULTS.theme);

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

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

const persistDoc = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (update.transactions.some((tr) =>
    tr.annotation(FromShareLoad) || tr.annotation(FromStateLoad)
  )) return;
  if (linkedToShare) forkFromShare();
  scheduleSave();
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
    doc: "",
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

titleInput.addEventListener("input", () => {
  if (linkedToShare) forkFromShare();
  scheduleSave();
});

wrapToggle.addEventListener("change", () => {
  view.dispatch({
    effects: wrapCompartment.reconfigure(
      wrapToggle.checked ? EditorView.lineWrapping : []
    ),
  });
  scheduleSave();
});

previewToggle.addEventListener("change", () => {
  if (previewToggle.checked) {
    previewEl.hidden = false;
    renderPreview(view.state.doc.toString());
  } else {
    previewEl.hidden = true;
  }
  view.requestMeasure();
  scheduleSave();
});

themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value);
  scheduleSave();
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
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: "" },
  });
  window.history.replaceState(null, "", location.pathname + location.search);
  flushSave();
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
  if (!location.hash) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("s");
  const keyB64 = params.get("k");
  if (!id || !keyB64) return false;
  try {
    const plaintext = await loadShare(id, keyB64);
    const { title = "", content = "" } = JSON.parse(plaintext);
    linkedToShare = true;
    titleInput.value = title;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: FromShareLoad.of(true),
    });
    return true;
  } catch (e) {
    console.error("load shared doc failed", e);
    return false;
  }
}

function forkFromShare() {
  if (!linkedToShare) return;
  linkedToShare = false;
  window.history.replaceState(null, "", location.pathname + location.search);
  // The user is now editing their own copy; queue a save so a reload
  // doesn't restore the pre-share state. saveState is a no-op when signed out.
  scheduleSave();
}

function applyState(state) {
  // If the user has already typed during the async load window, don't clobber.
  const pristine = view.state.doc.length === 0 && titleInput.value === "";
  if (!pristine) return;

  loadingState = true;
  try {
    titleInput.value = state.title || "";
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: state.doc || "" },
      annotations: FromStateLoad.of(true),
    });
    const settings = { ...SETTINGS_DEFAULTS, ...(state.settings || {}) };
    themeSelect.value = settings.theme;
    applyTheme(settings.theme);
    if (wrapToggle.checked !== !!settings.wrap) {
      wrapToggle.checked = !!settings.wrap;
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          wrapToggle.checked ? EditorView.lineWrapping : []
        ),
      });
    }
    const wantPreview = !!settings.preview;
    previewToggle.checked = wantPreview;
    previewEl.hidden = !wantPreview;
    if (wantPreview) renderPreview(view.state.doc.toString());
    view.requestMeasure();
  } finally {
    loadingState = false;
  }
}

async function loadUserState() {
  try {
    const res = await fetch("./api/state", { credentials: "same-origin" });
    if (!res.ok) return;
    const state = await res.json();
    applyState(state);
  } catch (e) {
    console.error("load state failed", e);
  }
}

function currentStatePayload() {
  return {
    title: titleInput.value,
    doc: view.state.doc.toString(),
    settings: {
      theme: themeSelect.value,
      wrap: !!wrapToggle.checked,
      preview: !!previewToggle.checked,
    },
  };
}

async function saveState() {
  if (loadingState) return;
  if (linkedToShare) return; // viewing someone else's share — not our state
  if (!auth.isEnabled()) return;
  if (!(await auth.isAuthenticated())) return;
  try {
    await fetch("./api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentStatePayload()),
      credentials: "same-origin",
    });
  } catch (e) {
    console.error("save state failed", e);
  }
}

function scheduleSave() {
  if (loadingState) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 500);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveState();
}

async function updateShareButton() {
  const signedIn = auth.isEnabled() && (await auth.isAuthenticated());
  if (!serverShareEnabled) {
    shareBtn.disabled = true;
    shareBtn.title = "Sharing is disabled on this server";
  } else if (!signedIn) {
    shareBtn.disabled = true;
    shareBtn.title = "Sign in to share";
  } else {
    shareBtn.disabled = false;
    shareBtn.title = "";
  }
}

async function refreshAuthUI() {
  await updateShareButton();
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

async function init() {
  let config = {};
  try {
    const res = await fetch("./api/config");
    if (res.ok) config = await res.json();
  } catch (e) {
    console.error("fetch config failed", e);
  }
  serverShareEnabled = config.shareEnabled === true;
  if (config.authEnabled) {
    await auth.initAuth(config);
  }
  await refreshAuthUI();

  const loadedFromShare = await loadFromHash();
  if (!loadedFromShare && auth.isEnabled() && (await auth.isAuthenticated())) {
    await loadUserState();
  }
}

init();
