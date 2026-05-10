import { createAuth0Client } from "@auth0/auth0-spa-js";

let client = null;
let cachedConfig = null;

export async function initAuth(config) {
  if (!config?.auth) return null;
  cachedConfig = config.auth;
  client = await createAuth0Client({
    domain: config.auth.domain,
    clientId: config.auth.clientId,
    authorizationParams: {
      audience: config.auth.audience,
      redirect_uri: window.location.origin + window.location.pathname,
    },
    cacheLocation: "localstorage",
    useRefreshTokens: true,
  });

  if (location.search.includes("code=") && location.search.includes("state=")) {
    try {
      await client.handleRedirectCallback();
    } catch (e) {
      console.error("auth callback failed", e);
    }
    const url = new URL(location.href);
    url.search = "";
    window.history.replaceState({}, document.title, url.toString());
  }
  return client;
}

export function isEnabled() {
  return client !== null;
}

export async function isAuthenticated() {
  return client ? client.isAuthenticated() : false;
}

export async function getUser() {
  return client ? client.getUser() : null;
}

export async function login() {
  if (!client) return;
  await client.loginWithRedirect();
}

export async function logout() {
  if (!client) return;
  await client.logout({
    logoutParams: {
      returnTo: window.location.origin + window.location.pathname,
    },
  });
}

export async function getAccessToken() {
  if (!client) return null;
  try {
    return await client.getTokenSilently();
  } catch {
    return null;
  }
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

export async function authFetch(input, init = {}) {
  const token = await getAccessToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
