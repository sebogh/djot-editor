/**
 * SPA entry point and orchestrator.
 *
 * Wires together the CodeMirror editor, the Djot preview, the toolbar,
 * sharing, auth UI and the working-state persistence loop. Subsystems
 * isolate the messy bits:
 *   - `./auth.js`            session-cookie auth client
 *   - `./share.js`           E2E-encrypted sharing
 *   - `./djot-highlight.js`  CodeMirror plugin for Djot syntax classes
 *
 * Init sequence (see `init` at the bottom):
 *   1. Fetch `/api/config` → discover share-flag and authEnabled.
 *   2. If authEnabled, init the auth client which calls `/api/me`.
 *   3. Refresh the auth UI (sign-in / avatar / share-button enablement).
 *   4. If the URL has a share fragment, load + decrypt it.
 *   5. Else, if signed in, load the user's working state from `/api/state`.
 *   6. Else, leave the editor empty — there is no client-side persistence
 *      for signed-out users.
 *
 * Persistence model (signed-in users only):
 *   - Edits to title, doc, theme, wrap, or preview funnel through
 *     `scheduleSave()`, which debounces 500 ms and PUTs the full state.
 *   - Viewing a share never writes — only after the user starts editing
 *     does `forkFromShare` strip the fragment and `scheduleSave` resume.
 */

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
import {generateName} from "./names";

/** Defaults applied at startup and as the floor when /api/state is sparse. */
const SETTINGS_DEFAULTS = Object.freeze({
  theme: "system",
  wrap: true,
  preview: false,
});

// Annotations that mark editor transactions originating from a share or
// state load, so the persistDoc updateListener doesn't treat the resulting
// doc change as a user edit and trigger a save loop.
const FromShareLoad = Annotation.define();
const FromStateLoad = Annotation.define();

// linkedToShare:    the editor currently mirrors a share-by-link payload.
//                   Edits in this state fork (clear the URL fragment) before
//                   any save can take effect.
// loadingState:     re-entrancy guard for applyState — suppresses saves
//                   while we're populating the UI from /api/state.
// saveTimer:        active setTimeout id for the debounced save; null when
//                   there is no pending save.
// serverShareEnabled: cached value from /api/config (the -share server flag).
let linkedToShare = false;
let loadingState = false;
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

/**
 * Set the page colour scheme. "system" lets Pico.css follow the OS pref.
 * @param {"system"|"light"|"dark"} theme
 */
function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

/**
 * Render `text` as HTML via Djot and inject it into the preview pane.
 * DOMPurify strips any unsafe constructs the renderer might emit.
 * Parse errors are swallowed so a transient mid-edit failure doesn't blank
 * the preview — the previous render stays visible.
 */
function renderPreview(text) {
  try {
    previewEl.innerHTML = DOMPurify.sanitize(renderHTML(parse(text)));
  } catch {
    /* leave previous render in place on transient parse errors */
  }
}

// Re-render the live preview whenever the doc changes (and the preview is
// visible). Cheap: Djot's parser handles editor-sized docs comfortably.
const previewSync = EditorView.updateListener.of((update) => {
  if (update.docChanged && !previewEl.hidden) {
    renderPreview(update.state.doc.toString());
  }
});

// Translate user-driven doc changes into save signals. Loads from share or
// /api/state carry an annotation so they're skipped here. If the editor was
// mirroring a share, the first edit forks first (clears the URL fragment)
// before we queue a save.
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

// Compartment lets us reconfigure line wrapping at runtime without
// rebuilding the whole editor state. Toggled by the Wrap switch and on
// state load.
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

/**
 * Convert a freeform title into a safe filename stem: collapse whitespace
 * to dashes, strip characters that are illegal on common filesystems, trim
 * leading/trailing dashes. Falls back to "untitled" for empty input.
 */
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
  titleInput.value = generateName();
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

/**
 * Briefly replace a button's label (e.g. "Copied!" / "Failed") and disable
 * it, then restore. Used to give async actions a visible acknowledgement.
 */
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

/**
 * If the URL fragment looks like `#s=<id>&k=<key>`, fetch and decrypt the
 * referenced share into the editor and mark the editor as `linkedToShare`.
 *
 * Returns whether a share was loaded — the caller uses this to decide
 * whether to fall through to /api/state.
 *
 * Failures (bad id, missing share, decryption error) log to console and
 * return false; the user lands on an empty editor in that case.
 */
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

/**
 * Detach the editor from the share that populated it. Called from the first
 * user edit while `linkedToShare` is true. The URL fragment is stripped (so
 * the address bar reflects the user's own copy) and a save is queued — but
 * `saveState` is a no-op when the user is signed out, so for unauthenticated
 * sessions the fork is purely a UI concern.
 */
function forkFromShare() {
  if (!linkedToShare) return;
  linkedToShare = false;
  window.history.replaceState(null, "", location.pathname + location.search);
  scheduleSave();
}

/**
 * Populate the UI from the state object returned by `/api/state`.
 *
 * The async window between editor mount and state arrival is short (sub-100ms
 * typically) but if the user starts typing during that window we'd otherwise
 * clobber their work. The pristine guard skips the apply in that case —
 * better to lose the saved state once than to lose the user's typing.
 *
 * @param {{title?: string, doc?: string, settings?: object}} state
 */
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

/**
 * GET /api/state and apply the result. Errors are non-fatal — the user just
 * sees an empty editor.
 */
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

/** Snapshot the editor + UI state into the JSON shape /api/state expects. */
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

/**
 * PUT the current state to the backend. No-op when:
 *   - we're inside applyState (loadingState),
 *   - the editor is mirroring a share (linkedToShare),
 *   - auth is disabled, or
 *   - the user is signed out.
 *
 * That last case is *the* mechanism by which signed-out users get no
 * persistence — every save path eventually goes through here.
 */
async function saveState() {
  if (loadingState) return;
  if (linkedToShare) return;
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

/** Coalesce many rapid changes into a single save 500 ms after the last one. */
function scheduleSave() {
  if (loadingState) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 500);
}

/** Cancel any pending debounced save and write immediately. Used by Clear
 *  and after forking from a share, where waiting 500 ms could race a reload. */
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveState();
}

/**
 * Sharing requires both the server `-share` flag *and* a signed-in user.
 * This function reflects those two preconditions on the Share button and
 * its tooltip.
 */
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

/**
 * Reflect the current auth state in the toolbar:
 *   - signed out → show Sign-in button, hide avatar dropdown
 *   - signed in  → swap to the avatar dropdown showing name/email/picture
 *
 * Also refreshes the share button via updateShareButton.
 */
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

/**
 * Top-level startup. Strictly serialised (no overlapping work) because the
 * editor's contents depend on which path we take in step 4–5.
 */
async function init() {
  // 1. Read the public feature flags. A failure here only loses the auth
  //    integration; the editor still works for ephemeral local editing.
  let config = {};
  try {
    const res = await fetch("./api/config");
    if (res.ok) config = await res.json();
  } catch (e) {
    console.error("fetch config failed", e);
  }
  serverShareEnabled = config.shareEnabled === true;

  // 2. Initialise auth (which itself calls /api/me to populate cachedUser).
  if (config.authEnabled) {
    await auth.initAuth(config);
  }

  // 3. Reflect what we now know in the toolbar.
  await refreshAuthUI();

  // 4-6. Decide what to put in the editor. A share link wins over personal
  //      state — the user explicitly asked to view that share by visiting
  //      the link.
  const loadedFromShare = await loadFromHash();
  if (!loadedFromShare && auth.isEnabled() && (await auth.isAuthenticated())) {
    await loadUserState();
  }

  // Fall back to a random title only after every load path has run, so users
  // with a saved title never see it flicker from random → saved.
  if (!titleInput.value) titleInput.value = generateName();
}

init();
