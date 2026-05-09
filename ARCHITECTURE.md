# Architecture

## Overview

zorto is a single-page editor for [Djot](https://djot.net/) source. The frontend runs in the browser; a small Go HTTP backend stores opaque encrypted payloads in SQLite to enable shareable links. Local working state (the in-progress document and title) is persisted to `localStorage` so the editor picks up where the user left off across browser sessions.

## Components

- **Frontend** (`web/`) — Vite-built SPA. CodeMirror 6 with a custom Djot highlighter, `@djot/djot` for AST + HTML preview, Pico.css for chrome.
- **Backend** (`main.go`) — `net/http` server. Embeds the built frontend via `embed.FS`. Exposes `/api/shares` (POST + GET-by-id). Stores opaque ciphertext in SQLite via `modernc.org/sqlite` (pure-Go driver).

## Persistence

- **Local** — `localStorage` keys `zorto:doc` and `zorto:title` hold the user's working copy. `theme` (legacy unprefixed key) holds the chosen color scheme.
- **Server** — table `shares(id, ciphertext, created_at)`. The server only sees opaque ciphertext; the AES-GCM IV is prepended to the ciphertext before base64url encoding.

## Sharing and the share fragment

When a document is shared, the URL gains a **share fragment** — the portion of the URL after `#`, of the form:

```
#s=<share-id>&k=<share-key>
```

Anatomy:

- `s` — **share id**. 12-character base64url string. Primary key of the row in `shares`. Public.
- `k` — **share key**. Base64url-encoded 32-byte AES-256-GCM key. Secret. Stays client-side because URL fragments are not sent to servers.

A URL containing a share fragment is a **share link**. Sharing is end-to-end encrypted: the server never sees plaintext.

### URL state model

The editor is in one of two URL states:

1. **Clean** — no share fragment. The editor reflects the user's local working copy. Edits stream to `localStorage`. Default state.
2. **Linked** — share fragment present. The editor reflects content decrypted from the share. Edits *do not* flow to `localStorage` while linked; the first edit forks (see below).

The application tracks the state internally as `linkedToShare` (boolean).

### State transitions

| Trigger                  | URL after              | Editor                          | `localStorage`            |
|--------------------------|------------------------|---------------------------------|----------------------------|
| Direct visit             | clean                  | loaded from `localStorage`      | unchanged                  |
| Visit via share link     | linked                 | loaded from share (async)       | **unchanged** (preserved) |
| Share load fails         | linked (refresh = retry) | falls back to `localStorage`  | unchanged                  |
| Edits while clean        | clean                  | mutated by user                 | debounced save             |
| Edits while linked       | becomes clean (fork)   | mutated by user                 | immediate save, then debounced |
| Click **Share**          | becomes linked         | unchanged                       | unchanged                  |
| Edits after Share        | becomes clean (fork)   | mutated by user                 | debounced save             |
| Click **Clear**          | becomes clean          | emptied                         | emptied                    |

### Fork on edit

When the editor is linked and the user makes the first edit, the app *forks* the shared snapshot:

1. The share fragment is removed from the URL (URL becomes clean).
2. `localStorage` resumes mirroring the editor.
3. The current editor content is saved to `localStorage` immediately (not debounced), so a refresh right after the fork doesn't fall back to stale local content.

Rationale: visiting a share link should feel like *viewing* someone's document. The moment you start editing, you have your own working copy, and the URL should reflect that — it no longer claims to be a faithful pointer to what's in your editor.

### Security model

End-to-end encryption protects against an honest-but-curious server operator. It does **not** protect against:

- A compromised origin — malicious or replaced JS sees plaintext and the key.
- `Referer` leakage of the share key — mitigated by setting `Referrer-Policy: same-origin`.
- Traffic analysis — the server sees IP, timing, and payload size.
- Loss of the URL — anyone with the share link can read the share.
