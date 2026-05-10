# Auth0 login (optional)

Login is opt-in. If the three env vars below are unset, the **Login** button does not appear and every endpoint behaves exactly as before. If they are set, users can sign in via Auth0 and the backend exposes `/api/me`. Login is **identity-only** in this first cut — it does not change the share/E2E model.

## 1. Create the Auth0 tenant

If you don't already have one:

1. Sign up at <https://auth0.com/signup>.
2. Pick a tenant region (closest to your users) and tenant domain, e.g. `zorto-prod`. Your tenant domain becomes `zorto-prod.<region>.auth0.com` (or `zorto-prod.auth0.com` for US-1).
3. *(Optional)* Configure a custom domain (`auth.qibli.net`) under **Branding → Custom Domains** to avoid `*.auth0.com` cookies. Not required for this guide.

For non-prod tinkering you can use the same tenant — just create a separate Application (step 2) per environment.

## 2. Create the Application (the SPA registration)

In the Auth0 dashboard:

1. **Applications → Applications → Create Application**.
2. Name: `Zorto Web` (or `Zorto Web (dev)`).
3. Type: **Single Page Web Applications**.
4. Click **Create**, then open the **Settings** tab.

Set the following on the **Settings** tab:

| Field                         | Value                                                                                  |
|-------------------------------|----------------------------------------------------------------------------------------|
| **Allowed Callback URLs**     | `http://localhost:5173/, https://qibli.net/zorto/`                                     |
| **Allowed Logout URLs**       | `http://localhost:5173/, https://qibli.net/zorto/`                                     |
| **Allowed Web Origins**       | `http://localhost:5173, https://qibli.net`                                             |
| **Application Login URI**     | *(leave blank)*                                                                        |
| **Token Endpoint Auth Method**| `None` (default for SPA — no client secret)                                            |

Under **Advanced Settings → Grant Types**, ensure **Authorization Code** and **Refresh Token** are enabled (the default for SPA). Disable **Implicit** — we use Authorization Code with PKCE.

Save changes. Note down from this page:

- **Domain** — e.g. `zorto-prod.eu.auth0.com` (no scheme).
- **Client ID** — e.g. `aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV`.

## 3. Create the API (the audience)

The API identifier is what the backend validates the access token's `aud` claim against. It is just a stable identifier, **not** a URL that needs to resolve.

1. **Applications → APIs → Create API**.
2. Name: `Zorto API`.
3. Identifier: `https://zorto.qibli.net/api` (any URI-shaped string is fine — pick one and never change it; it goes into `AUTH0_AUDIENCE`).
4. Signing Algorithm: **RS256** (the default; do not switch to HS256).
5. Click **Create**.

On the API's **Settings** tab, leave **Allow Offline Access** enabled if you want refresh tokens to work for SPA sessions across browser restarts (recommended).

## 4. Verify the JWKS endpoint

The backend fetches the signing keys from Auth0's JWKS URL. Sanity-check it now so a typo in `AUTH0_DOMAIN` surfaces here, not at first login:

```sh
curl -sSf "https://<your-domain>/.well-known/jwks.json" | head
```

You should see a JSON object with a `keys` array.

## 5. Configure zorto

The backend and frontend both read three env vars. The backend serves the public values to the frontend via `/api/config`, so you only set them in **one** place — wherever the Go binary runs.

| Env var             | Example                                | Where it comes from        |
|---------------------|----------------------------------------|----------------------------|
| `AUTH0_DOMAIN`      | `qibli.eu.auth0.com`              | Application → Settings     |
| `AUTH0_CLIENT_ID`   | `<CLIENT_ID>`     | Application → Settings     |
| `AUTH0_AUDIENCE`    | `https://qibli.net`          | API → Settings → Identifier|

### Local development

```sh

export AUTH0_DOMAIN=qibli.eu.auth0.com                                                                                                  export AUTH0_CLIENT_ID=<CLIENT_ID>
export AUTH0_AUDIENCE=https://qibli.net
make run
```

In a separate terminal run `cd web && npm run dev`. Vite proxies `/api/*` to the Go server, so `/api/config` will report auth as enabled and the **Login** button will render.

### Production (systemd)

Add the env vars to `/etc/systemd/system/zorto.service` under `[Service]`:

```ini
export AUTH0_DOMAIN=qibli.eu.auth0.com                                                                                                  export AUTH0_CLIENT_ID=<CLIENT_ID>
export AUTH0_AUDIENCE=https://qibli.net
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl restart zorto
```

To **disable** login again, remove the `Environment=` lines and restart. The frontend reads `/api/config` on load and hides the Login button if auth is not configured.

## 6. Smoke test

1. Open the app, click **Login**.
2. You should be redirected to `https://<your-domain>/u/login`, sign up or log in.
3. After redirect back, the toolbar should show your name (or email) and a **Logout** button.
4. In the browser devtools, `fetch('./api/me', { headers: { Authorization: 'Bearer ' + token } })` (the frontend does this automatically on login) should return your `sub`, `email`, and `name`.

If `/api/me` returns 401:

- Check that `AUTH0_AUDIENCE` on the backend exactly matches the API Identifier — including the `https://` and any trailing slash.
- Check the server log; the JWT validator logs the specific reason (bad audience, bad issuer, expired, signature).
