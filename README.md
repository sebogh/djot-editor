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

## Optional login (Auth0)

Login is opt-in. If `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and `AUTH0_AUDIENCE` are set on the backend, a **Login** button appears in the toolbar and the backend exposes `/api/me`. With the env vars unset, the app behaves exactly as before. See [AUTH.md](./AUTH.md) for the Auth0 tenant setup.

## Deploy to a VPS (manual install behind Nginx)

The intended production layout is a single Go binary running under systemd on `127.0.0.1:8080`, fronted by an existing Nginx that already serves other sites. The site is mounted at the path `/zorto/`.

1. **Build a Linux binary** on a Linux machine:

   ```sh
   make backend
   ```

   This produces `./zorto` with the frontend embedded. (From a non-Linux dev box: `GOOS=linux GOARCH=amd64 go build .` — `modernc.org/sqlite` is pure-Go.)

2. **Copy the binary and the deploy templates to the VPS**:

   ```sh
   scp zorto deploy/zorto.service deploy/nginx-zorto.conf qibli.net:/tmp/
   ```

3. **On the VPS, install the binary, user, data dir, and systemd unit**:

   ```sh
   sudo install -m 755 /tmp/zorto /usr/local/bin/zorto
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin zorto
   sudo install -d -o zorto -g zorto /var/lib/zorto
   sudo install -m 644 /tmp/zorto.service /etc/systemd/system/zorto.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now zorto
   ```

   The default `ExecStart` runs with `-share=false` (no new shares can be created). To allow share creation, edit `/etc/systemd/system/zorto.service`, append `-share=true` to the `ExecStart` line, then `sudo systemctl daemon-reload && sudo systemctl restart zorto`.

4. **Add the Nginx snippet** from `/tmp/nginx-zorto.conf` inside the existing `server { ... }` block for `qibli.net` (anywhere among the `location` directives), then:

   ```sh
   sudo nginx -t && sudo systemctl reload nginx
   ```

   The site is now live at `https://qibli.net/zorto/`.

**Updates:** `make deploy` (rebuilds the binary, `scp`s it to `qibli.net:/tmp/`, then `ssh`s in to install it and restart the service).
