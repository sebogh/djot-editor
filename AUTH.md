# Auth0 login (optional)

Login is opt-in. If the three `AUTH0_*` env vars are unset, the **Sign in**
button does not appear and every endpoint behaves as before. If they are set,
zorto runs an OAuth2 + OIDC **Backend-for-Frontend (BFF)** flow: the Go server
is the confidential OAuth client and holds all tokens; the browser only ever
sees an `HttpOnly` session cookie. Login is **identity-only** — sharing
endpoints stay anonymous and end-to-end encrypted.

This is a deliberate change from the older SPA-with-tokens setup. Refresh
tokens never reach the browser, so an XSS foothold can't exfiltrate them.
The trade-off is one DB round-trip per authenticated request to look up the
session row.

## Architecture in one diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (SPA)                                                   │
│   • clicks Sign in   → window.location = /api/auth/login         │
│   • reads /api/me    → { sub, name, email, picture }             │
│   • clicks Logout    → POST /api/auth/logout, follow logoutUrl   │
│  Cookie: zorto_session  (HttpOnly, Secure, SameSite=Lax)         │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────┐    ┌────────────────────┐
│  Go backend (BFF / confidential client)│◄──►│  Auth0 tenant       │
│   • /api/auth/login    → 302 to Auth0  │    │   • /authorize      │
│   • /api/auth/callback → exchange code │    │   • /oauth/token    │
│   • /api/auth/logout   → drop session  │    │   • /v2/logout      │
│   • /api/me            → from session  │    │   • JWKS            │
│  Tables: sessions, auth_states         │    └────────────────────┘
└────────────────────────────────────────┘
```

## 1. Create the Auth0 tenant

If you don't already have one:

1. Sign up at <https://auth0.com/signup>.
2. Pick a tenant region and tenant domain, e.g. `zorto-prod`. Your domain
   becomes `zorto-prod.<region>.auth0.com`.

## 2. Create the Application (**Regular Web Application**)

The backend is now a confidential OAuth client. Pick the right type:

1. **Applications → Applications → Create Application**.
2. Name: `Zorto Web`.
3. Type: **Regular Web Applications** (not Single-Page).
4. Click **Create**, then open the **Settings** tab and fill in:

   | Field | Value |
   |-------|-------|
   | **Allowed Callback URLs** | `http://localhost:5173/api/auth/callback, https://qibli.net/zorto/api/auth/callback` |
   | **Allowed Logout URLs**   | `http://localhost:5173/, https://qibli.net/zorto/` |
   | **Allowed Web Origins**   | `http://localhost:5173, https://qibli.net` |
   | **Token Endpoint Auth Method** | `Post` (the default for Regular Web Apps — uses the client secret) |

5. Under **Advanced Settings → Grant Types**, ensure **Authorization Code** is
   enabled. **Refresh Token** can be left disabled — zorto's session lives in
   the cookie/DB and re-auths via the hosted login page when it expires.
6. Save. Note **Domain**, **Client ID**, and **Client Secret**.

If you previously set the app up as **Single Page Application**, the cleanest
path is to delete it and create a new Regular Web App; otherwise ensure the
type is switched and the secret is generated.

## 3. (No API resource needed)

The earlier setup required creating an Auth0 API to provide an `audience`. The
BFF flow doesn't need one — we use the OIDC `id_token` for the user's
identity and don't issue API access tokens. You can safely delete the old
`Zorto API` entry, and `AUTH0_AUDIENCE` is no longer read.

## 4. Verify the JWKS endpoint

The backend validates the `id_token` signature against Auth0's JWKS.

```sh
curl -sSf "https://<your-domain>/.well-known/jwks.json" | head
```

You should see a JSON object with a `keys` array.

## 5. Configure zorto

| Env var | Required | Example | Where it comes from |
|---------|:-:|---------|---------------------|
| `AUTH0_DOMAIN` | yes | `qibli.eu.auth0.com` | Application → Settings |
| `AUTH0_CLIENT_ID` | yes | `aB1cD2eF3…` | Application → Settings |
| `AUTH0_CLIENT_SECRET` | yes | `…` (treat as a password) | Application → Settings |
| `AUTH0_REDIRECT_URI` | optional | `https://qibli.net/zorto/api/auth/callback` | derived from request if unset |

`AUTH0_REDIRECT_URI` is only needed when the SPA is served under a path prefix
the Go backend doesn't see (e.g. behind nginx that strips `/zorto/`). For
local dev with the Vite proxy, leave it unset — the backend derives it from
the incoming request.

### Local development

```sh
export AUTH0_DOMAIN=qibli.eu.auth0.com
export AUTH0_CLIENT_ID=<CLIENT_ID>
export AUTH0_CLIENT_SECRET=<CLIENT_SECRET>
make run
```

In a separate terminal: `cd web && npm run dev`. Vite proxies `/api/*` to
`localhost:8080`, so the **Sign in** button renders and `/api/auth/login`
works end to end.

### Production (systemd)

Add the env vars to `/etc/systemd/system/zorto.service` under `[Service]`:

```ini
Environment=AUTH0_DOMAIN=qibli.eu.auth0.com
Environment=AUTH0_CLIENT_ID=<CLIENT_ID>
Environment=AUTH0_CLIENT_SECRET=<CLIENT_SECRET>
Environment=AUTH0_REDIRECT_URI=https://qibli.net/zorto/api/auth/callback
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl restart zorto
```

To **disable** login, remove these `Environment=` lines and restart. The SPA
reads `/api/config` on load and hides the Sign-in button when `authEnabled`
is false.

## 6. Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/auth/login`    | Generate PKCE pair + state, store in `auth_states`, 302 to Auth0 `/authorize`. |
| GET  | `/api/auth/callback` | Validate state, exchange code+verifier+secret at `/oauth/token`, validate `id_token` via JWKS, insert `sessions` row, set `zorto_session` cookie, 302 back to SPA root. |
| POST | `/api/auth/logout`   | Delete the session row, clear the cookie, return `{ logoutUrl }` for the SPA to navigate to (Auth0's `/v2/logout`). |
| GET  | `/api/me`            | Read cookie → look up session → return cached `{ sub, name, email, picture }`. |

## 7. Cookies

- `zorto_session` — random 32-byte session id, base64url. `HttpOnly`,
  `SameSite=Lax`, `Secure` whenever the request is HTTPS (auto-detected via
  TLS or `X-Forwarded-Proto`). 30-day rolling TTL.

`SameSite=Lax` is the right setting here: cross-site `POST` to
`/api/auth/logout` is blocked (no cookie sent), and the top-level GET
redirect from Auth0 back to `/api/auth/callback` carries the cookie as
expected.

## 8. Tables

- `sessions(id, sub, user_json, created_at, expires_at)` — one row per
  active login. `user_json` caches the OIDC profile for `/api/me`.
- `auth_states(state, verifier, created_at)` — short-lived (10 min) rows
  holding the PKCE verifier and CSRF state for an in-flight login. Single-use:
  the row is deleted on first callback hit.

Both tables are cleaned up at startup; expired rows are also rejected at use
time.

## 9. Smoke test

1. Open the app. The **Sign in** button should be visible.
2. Click it; you should be redirected to `https://<your-domain>/u/login`.
3. Sign up or log in. Auth0 redirects back to `/api/auth/callback`, which
   sets the cookie and redirects to the SPA root.
4. The toolbar should show your avatar; the dropdown contains **Logout**.
5. In devtools, `fetch('./api/me').then(r => r.json())` should return your
   `{ sub, name, email, picture }`. Check the **Application → Cookies** tab —
   you should see `zorto_session` marked HttpOnly.

## 10. Troubleshooting

**Callback URL mismatch.** Auth0 will refuse the redirect if the URL in
`Allowed Callback URLs` doesn't exactly match what the backend sent in the
`/authorize` request. In production, this is almost always
`AUTH0_REDIRECT_URI` not matching the registered URL — they must be
character-identical.

**`/api/auth/callback` returns 400 "invalid state".** The user opened the
login URL in one browser and clicked the Auth0 confirmation link in another,
or the in-flight `auth_states` row was wiped (e.g. binary restart > 10 min
between login start and callback). Click **Sign in** again.

**`/api/me` returns 401 right after login.** The cookie wasn't set. Likely
causes:
- Behind a proxy that's stripping `Set-Cookie`.
- Production deploy with `Secure` cookies but the proxy serves HTTP to the
  backend without `X-Forwarded-Proto: https`. Configure the proxy to set it.
- The browser is rejecting the cookie because of a `__Secure-` / `__Host-`
  prefix mismatch — zorto deliberately doesn't use those prefixes so this
  shouldn't happen, but third-party browser extensions can interfere.

**Token exchange fails with `invalid_client`.** `AUTH0_CLIENT_SECRET` is
wrong, or the Auth0 application is still set to type **Single Page
Application** (which has no secret). Switch the app to **Regular Web
Application** and copy the new secret.
