/**
 * Cookie-session auth client.
 *
 * The Go backend is a confidential OAuth client (BFF) and holds all tokens.
 * This module is a thin adapter the SPA uses to:
 *
 *   • discover whether auth is configured (`isEnabled`),
 *   • read the current user's profile via `/api/me` (`getUser`,
 *     `isAuthenticated`),
 *   • redirect to backend endpoints to start a login or logout
 *     (`login`, `logout`).
 *
 * No tokens are stored in the browser — the browser only ever holds the
 * HttpOnly `zorto_session` cookie set by the backend. Cookies are sent
 * automatically on same-origin fetches; `credentials: "same-origin"` is
 * passed explicitly here for clarity.
 *
 * State held in this module:
 *   - `enabled`     : whether the backend reported auth is configured
 *   - `cachedUser`  : last known user profile, or null if signed out
 *
 * `cachedUser` is refreshed from `/api/me` on init and on demand via
 * `refreshUser`. After a login or logout the page navigates away (window
 * location change), so the next module load starts from a fresh slate.
 */

let enabled = false;
let cachedUser = null;

/** @returns {boolean} whether the backend has auth configured. */
export function isEnabled() {
  return enabled;
}

/** @returns {Promise<boolean>} whether a signed-in user is currently known. */
export async function isAuthenticated() {
  return cachedUser !== null;
}

/**
 * @returns {Promise<{sub: string, name?: string, email?: string, picture?: string}|null>}
 *          the cached user profile, or null when signed out.
 */
export async function getUser() {
  return cachedUser;
}

/**
 * One-time initialisation from the value returned by `/api/config`. If
 * `config.authEnabled` is true, calls `/api/me` to populate `cachedUser`.
 * @param {{authEnabled?: boolean}} config
 * @returns {Promise<object|null>} the user profile, or null if not signed in.
 */
export async function initAuth(config) {
  if (!config?.authEnabled) {
    enabled = false;
    cachedUser = null;
    return null;
  }
  enabled = true;
  await refreshUser();
  return cachedUser;
}

/**
 * Re-fetch `/api/me` and update `cachedUser`. Use after an action that may
 * have changed the session (rare in this app — login/logout reload the page).
 * @returns {Promise<object|null>}
 */
export async function refreshUser() {
  if (!enabled) {
    cachedUser = null;
    return null;
  }
  try {
    const res = await fetch("./api/me", { credentials: "same-origin" });
    if (res.ok) {
      cachedUser = await res.json();
    } else {
      cachedUser = null;
    }
  } catch {
    cachedUser = null;
  }
  return cachedUser;
}

/**
 * Begin a login. Navigates the whole page to `/api/auth/login`; the backend
 * then redirects to Auth0 and ultimately back to the SPA root with the
 * session cookie set. No-op when auth is disabled.
 */
export function login() {
  if (!enabled) return;
  window.location.href = "./api/auth/login";
}

/**
 * End the session. Two-step:
 *   1. POST `/api/auth/logout` — backend deletes the session row and clears
 *      the cookie, responding with `{ logoutUrl }` pointing at Auth0's
 *      `/v2/logout`.
 *   2. Navigate to that URL so Auth0 also clears its tenant cookie. Auth0
 *      then redirects back to the SPA root.
 *
 * Falls back to a plain reload if anything goes wrong, so the user is at
 * least no longer in the signed-in UI state.
 */
export async function logout() {
  if (!enabled) return;
  try {
    const res = await fetch("./api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    cachedUser = null;
    if (res.ok) {
      const { logoutUrl } = await res.json();
      if (logoutUrl) {
        window.location.href = logoutUrl;
        return;
      }
    }
  } catch (e) {
    console.error("logout failed", e);
  }
  // Fallback: at least drop the SPA's cached state and reload.
  window.location.reload();
}

/**
 * Generate a deterministic 5×5 mirrored identicon as an inline SVG data URL.
 * Used as a fallback avatar when the OIDC profile lacks a `picture` field.
 * The hash drives both the colour (hue) and the cell pattern, so the same
 * seed always renders the same icon.
 *
 * @param {string} seed   typically the user's `sub` or display name.
 * @returns {Promise<string>} a `data:image/svg+xml;…` URL.
 */
export async function identiconDataUrl(seed) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const b = new Uint8Array(buf);
  const hue = Math.round((b[0] / 255) * 360);
  const fg = `hsl(${hue}, 55%, 45%)`;
  const bg = `hsl(${hue}, 30%, 92%)`;
  let cells = "";
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if ((b[1 + row * 3 + col] & 1) === 0) continue;
      cells += `<rect x="${col * 10}" y="${row * 10}" width="10" height="10"/>`;
      const mirror = 4 - col;
      if (mirror !== col) {
        cells += `<rect x="${mirror * 10}" y="${row * 10}" width="10" height="10"/>`;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><rect width="50" height="50" fill="${bg}"/><g fill="${fg}">${cells}</g></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
