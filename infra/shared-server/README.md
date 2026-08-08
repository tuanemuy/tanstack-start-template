# Shared server (Apache + SSH)

Deploying the Node runtime to a shared host — the kind that gives you SSH, cron, an Apache document root per subdomain, and a control panel that issues free Let's Encrypt certificates, but no root and no Docker.

This is not a supported production target. It fits verification and staging sites where a VPS is not available, and it trades away process supervision guarantees to get there.

## Requirements

Check these on the server before anything else:

```bash
ldd --version | head -1   # glibc 2.28 or newer
node -v                   # 22.12 or newer (see engines in package.json)
```

The official Node.js Linux x64 builds require glibc >= 2.28. On an older host, install from the [Node.js unofficial builds](https://unofficial-builds.nodejs.org/) instead — they publish glibc 2.17 binaries.

`@libsql/client` pulls in `libsql`, a native module. If its prebuilt binary does not load on the host, switch `packages/core/src/adapters/libsql/client.ts` to import from `@libsql/client/web` and point `DATABASE_URL` at a remote `libsql://` instance — that entry point is pure JavaScript and speaks hrana over HTTP.

## Layout

`provision.sh` places the application beside the document root, never inside it. The SQLite file is served as a static asset by Apache if it ends up under `public_html`.

```
~/foo.example.com/
├─ public_html/     # document root — .htaccess only
└─ app/             # deploy target (the rsynced repo)
   └─ apps/web/
      ├─ dist/
      ├─ data/app.db
      └─ .env
```

The app process reads `process.env` only; `apps/web/.env` is injected at the invocation via Node's `--env-file-if-exists` (`pm2 --node-args` for the server, the `--env-file-if-exists=.env` baked into the `db:migrate:node` script for the migrator). `apps/web` is the process cwd, which is also what `DATABASE_URL=file:./data/app.db` resolves against.

Requests reach the Node process through a `mod_proxy` rewrite in `.htaccess`, so the process binds `127.0.0.1` on a port that is never exposed directly.

## Setup

1. Add the subdomain in the hosting control panel and enable its free SSL certificate. The control panel is what replaces the reverse-proxy and certificate work you would otherwise do by hand.

2. Copy this directory to the server and provision the site:

   ```bash
   ./provision.sh foo.example.com
   ```

   It allocates a port (recorded in `~/.shared-server-ports`), renders `.htaccess` from `htaccess.template`, creates `app/.env`, and prints the values needed in step 3.

3. Set the repository secrets and variables:

   | Name | Kind | Example |
   | --- | --- | --- |
   | `SHARED_SERVER_SSH_KEY` | secret | private key of a keypair whose public half is in the server's `~/.ssh/authorized_keys` |
   | `SHARED_SERVER_HOST` | secret | `sv1234.example-hosting.jp` |
   | `SHARED_SERVER_USER` | secret | the SSH account name |
   | `SHARED_SERVER_PORT` | variable | `10022` — many shared hosts do not use 22 |
   | `SHARED_SERVER_REMOTE_PATH` | variable | `/home/user/foo.example.com/app` |
   | `SHARED_SERVER_PM2_NAME` | variable | `foo.example.com` |
   | `SHARED_SERVER_APP_URL` | variable | `https://foo.example.com` |

4. Make `pnpm` and `pm2` available to the deploy shell, then register the reboot recovery:

   ```bash
   corepack enable          # the workflow calls pnpm over SSH
   npm install -g pm2
   crontab -e
   ```

   ```cron
   */10 * * * * $HOME/.nodebrew/current/bin/pm2 resurrect > /dev/null 2>&1
   ```

   Shared hosts reboot on their own maintenance schedule and there is no systemd unit to bring the process back, so `pm2 resurrect` on a timer is the only recovery path.

5. Push to `staging`, or run the workflow manually.

## Deploys

`.github/workflows/deploy-shared-server.yml` builds on the runner and ships the result. The build never runs on the host: shared hosting caps per-tenant memory and CPU, and `vite build` is the step most likely to be killed.

The workflow installs dependencies on the server including devDependencies, because `db:migrate:node` runs through `tsx`. Dropping to `--prod` requires a migration entry point that does not need a TypeScript loader.

`data/` and `.env` are excluded from the `rsync --delete`, so the database and the server-side configuration survive deploys.

## Constraints

- **Long-running processes are at the host's discretion.** Terms of service generally prohibit placing significant load on shared infrastructure, and a resident HTTP server is not what these hosts optimize for. Confirm this is acceptable before putting a client's hosting account behind it.
- **No WebSocket.** `mod_proxy`'s `[P]` flag forwards HTTP only. The Node runtime does not need upgrades today; a feature that does needs a different host.
- **One process, one SQLite file.** The relay, consumer, and pruner all run inside the HTTP process (see `docs/runtime_node.md`). Running a second instance against the same database file would double-run the outbox sweeps.
- **Ports are hand-allocated.** `~/.shared-server-ports` is the registry; nothing enforces it outside `provision.sh`.
