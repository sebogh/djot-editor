# djot-editor

A Confluence-like wiki where documents are authored directly in [Djot](https://djot.net/) with fast, precise syntax highlighting — no rendered HTML preview, just the source with colors.

## Develop

```sh
npm install
npx vite
```

Opens at http://localhost:5173.

## Deploy

```sh
make deploy
```

Builds with Vite and rsyncs `dist/` to the host configured in the `Makefile` (`DEPLOY_HOST`, `DEPLOY_PATH`). Override on the command line if needed, e.g. `make deploy DEPLOY_HOST=staging.example.com`.
