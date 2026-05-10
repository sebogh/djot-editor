<div align="center">
<img src="./web/public/z_logo_128x128.png" alt="zorto logo" width="128" height="128">
</div>

# zorto

A Confluence-like wiki where documents are authored directly in
[Djot](https://djot.net/).

## Develop

**Frontend dev server** (Vite, with HMR):

```sh
cd web
npm install
npm run dev
```

**Backend** (Go, serves the built frontend + `/api`):

```sh
make run
```

Vite proxies `/api/*` to the Go server, so run both for the full app.

**Optional Login**:

If the following env vars are set on the backend, a **Sign in** button appears
in the toolbar and the backend integrates Auth0 as a confidential OAuth client:

- `AUTH0_DOMAIN`,
- `AUTH0_AUDIENCE`,
- `AUTH0_CLIENT_ID`,
- `AUTH0_CLIENT_SECRET`, and (conditionally)
- `AUTH0_REDIRECT_URI`.

If auth is enabled, the browser never sees a token, only an HttpOnly session
cookie.
