// Cookie-session auth client. The backend (BFF) holds all OAuth state; the
// SPA only knows whether auth is enabled and who the current user is.

let enabled = false;
let cachedUser = null;

export function isEnabled() {
  return enabled;
}

export async function isAuthenticated() {
  return cachedUser !== null;
}

export async function getUser() {
  return cachedUser;
}

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

export function login() {
  if (!enabled) return;
  window.location.href = "./api/auth/login";
}

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
