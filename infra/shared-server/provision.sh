#!/usr/bin/env bash
# One-time provisioning for a site on a shared host.
#
# Run this ON THE SERVER, once per site. Ongoing deploys are handled by
# `.github/workflows/deploy-shared-server.yml`.
#
#   ./provision.sh foo.example.com
#   ./provision.sh foo.example.com 3007   # explicit port
#
# Creates the app directory as a SIBLING of the document root, never
# inside it: the SQLite file lives under `app/apps/web/data/` and would
# be downloadable by anyone if it sat below public_html.
#
#   ~/foo-stg.example.com/
#   ├─ public_html/     <- document root, gets the .htaccess only
#   └─ app/             <- deploy target (the rsynced repo)
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 <domain> [port]" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/htaccess.template"
# Ports are recorded here so a second site cannot silently claim a port
# that is already bound — the failure mode is otherwise a site quietly
# serving another site's app.
REGISTRY="$HOME/.shared-server-ports"
PORT_MIN=3001
PORT_MAX=3099

[[ -f "$TEMPLATE" ]] || { echo "missing template: $TEMPLATE" >&2; exit 1; }
touch "$REGISTRY"

if existing=$(grep -E "^${DOMAIN}[[:space:]]" "$REGISTRY" 2>/dev/null); then
  echo "error: ${DOMAIN} is already registered:" >&2
  echo "  $existing" >&2
  exit 1
fi

PORT="${2:-}"
if [[ -n "$PORT" ]]; then
  if grep -qE "[[:space:]]${PORT}$" "$REGISTRY"; then
    echo "error: port ${PORT} is already taken (see $REGISTRY)" >&2
    exit 1
  fi
else
  for candidate in $(seq "$PORT_MIN" "$PORT_MAX"); do
    grep -qE "[[:space:]]${candidate}$" "$REGISTRY" || { PORT="$candidate"; break; }
  done
  [[ -n "$PORT" ]] || { echo "error: no free port in ${PORT_MIN}-${PORT_MAX}" >&2; exit 1; }
fi

ROOT="$HOME/$DOMAIN"
DOCROOT="$ROOT/public_html"
APPDIR="$ROOT/app"

# The document root is created by the hosting control panel when the
# subdomain is added — its absence means that step was skipped.
if [[ ! -d "$DOCROOT" ]]; then
  echo "error: $DOCROOT does not exist." >&2
  echo "Add the subdomain in the hosting control panel first, then re-run." >&2
  exit 1
fi

# The deploy rsyncs the repo into $APPDIR, so runtime paths live under
# apps/web — the process cwd. `.env` and `data/` sit there too; both are
# excluded from the deploy's `rsync --delete` so they survive deploys.
mkdir -p "$APPDIR/apps/web/data"

if [[ -e "$DOCROOT/.htaccess" ]]; then
  cp "$DOCROOT/.htaccess" "$DOCROOT/.htaccess.bak"
  echo "note: existing .htaccess backed up to .htaccess.bak"
fi
sed "s/__PORT__/${PORT}/g" "$TEMPLATE" > "$DOCROOT/.htaccess"

ENVFILE="$APPDIR/apps/web/.env"
cat > "$ENVFILE" <<EOF
DATABASE_URL=file:./data/app.db
APP_URL=https://${DOMAIN}
PORT=${PORT}
HOSTNAME=127.0.0.1
EOF
# The .env carries no secrets yet, but it will — keep it off the group
# and other bits on a machine shared with other tenants.
chmod 600 "$ENVFILE"

printf '%s\t%s\n' "$DOMAIN" "$PORT" >> "$REGISTRY"

cat <<EOF

provisioned ${DOMAIN} on port ${PORT}

  app dir   : ${APPDIR}
  docroot   : ${DOCROOT}
  env file  : ${ENVFILE}
  registry  : ${REGISTRY}

next steps:
  1. Enable the free SSL certificate for ${DOMAIN} in the control panel.
  2. Add these to the GitHub repository secrets / variables:
       SHARED_SERVER_REMOTE_PATH = ${APPDIR}
       SHARED_SERVER_PM2_NAME    = ${DOMAIN}
  3. Run the deploy workflow. It installs deps, migrates, and starts pm2.
EOF
