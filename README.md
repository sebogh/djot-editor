# zorto

A Confluence-like wiki where documents are authored directly in [Djot](https://djot.net/) with fast, precise syntax highlighting — no rendered HTML preview, just the source with colors.

## Develop

Frontend dev server (Vite, with HMR):

```sh
cd web
npm install
npm run dev
```

Backend (Go, serves the built frontend + `/api`):

```sh
make run
```

Vite proxies `/api/*` to the Go server, so run both for the full app.

## Deploy

```sh
make deploy
```

Builds the frontend and rsyncs `web/dist/` to the host configured in the `Makefile` (`DEPLOY_HOST`, `DEPLOY_PATH`).
