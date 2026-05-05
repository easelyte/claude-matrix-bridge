#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
API_BASE="https://api.cloudflare.com/client/v4"

HOSTNAME_VALUE=""
SERVICE_URL=""
API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
ZONE_ID="${CLOUDFLARE_ZONE_ID:-}"
ZONE_NAME="${CLOUDFLARE_ZONE_NAME:-}"
TUNNEL_ID="${CLOUDFLARE_TUNNEL_ID:-}"
TUNNEL_NAME="${TUNNEL_NAME:-claude-matrix-viewer-$(hostname -s 2>/dev/null || echo mac)}"
CONFIG_PATH="${CLOUDFLARE_CONFIG_PATH:-$HOME/.cloudflared/claude-matrix-viewer.yml}"
CREDENTIALS_PATH="${CLOUDFLARE_CREDENTIALS_PATH:-$HOME/.cloudflared/claude-matrix-viewer-credentials.json}"

APPLY_ENV=0
APPLY_DNS=0
CREATE_TUNNEL=0
WRITE_CONFIG=0
PROMPT_API_TOKEN=0

usage() {
  cat <<'EOF'
Usage: setup/cloudflare-macos.sh [options]

Dry-run by default. It detects existing Cloudflare setup and prints the viewer
ingress block without changing cloudflared or bridge config.

Options:
  --hostname HOST          Public viewer hostname, e.g. viewer.example.com
  --service-url URL        Local viewer service URL (default from MATRIX_VIEWER_PORT)
  --apply-env             Set VIEWER_BASE_URL=https://HOST in .env
  --apply-dns             Upsert HOST as a proxied CNAME to the tunnel
  --create-tunnel         Create a new Cloudflare tunnel through the API
  --write-config          Write a bridge-managed cloudflared config file
  --tunnel-id ID          Existing Cloudflare tunnel ID for DNS/config
  --tunnel-name NAME      Tunnel name when creating a tunnel
  --api-token TOKEN       One-shot Cloudflare API token (not persisted)
  --prompt-api-token      Prompt for an API token if needed and stdin is a TTY
  --account-id ID         Cloudflare account ID
  --zone-id ID            Cloudflare zone ID
  --zone-name NAME        Cloudflare zone name
  --env PATH              .env path (default: repo .env)
  --config PATH           Bridge-managed cloudflared config output path
  -h, --help              Show this help

Examples:
  setup/cloudflare-macos.sh --hostname viewer.example.com
  setup/cloudflare-macos.sh --hostname viewer.example.com --apply-env
  CLOUDFLARE_API_TOKEN=... setup/cloudflare-macos.sh --hostname viewer.example.com --tunnel-id <id> --apply-dns
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_VALUE="$2"; shift 2 ;;
    --service-url) SERVICE_URL="$2"; shift 2 ;;
    --apply-env) APPLY_ENV=1; shift ;;
    --apply-dns) APPLY_DNS=1; shift ;;
    --create-tunnel) CREATE_TUNNEL=1; shift ;;
    --write-config) WRITE_CONFIG=1; shift ;;
    --tunnel-id) TUNNEL_ID="$2"; shift 2 ;;
    --tunnel-name) TUNNEL_NAME="$2"; shift 2 ;;
    --api-token) echo "Warning: --api-token can be visible in process listings; prefer CLOUDFLARE_API_TOKEN or --prompt-api-token." >&2; API_TOKEN="$2"; shift 2 ;;
    --prompt-api-token) PROMPT_API_TOKEN=1; shift ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --zone-id) ZONE_ID="$2"; shift 2 ;;
    --zone-name) ZONE_NAME="$2"; shift 2 ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    --config) CONFIG_PATH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

env_value() {
  local key="$1" default_value="$2"
  if [ -f "$ENV_FILE" ]; then
    awk -F= -v key="$key" '
      $0 !~ /^[[:space:]]*#/ && $1 == key {
        sub(/^[^=]*=/, "");
        gsub(/^["'\'']|["'\'']$/, "");
        print;
        found=1;
        exit;
      }
      END { if (!found) exit 1 }
    ' "$ENV_FILE" 2>/dev/null || printf '%s' "$default_value"
  else
    printf '%s' "$default_value"
  fi
}

if [ -z "$SERVICE_URL" ]; then
  VIEWER_PORT="$(env_value MATRIX_VIEWER_PORT 9803)"
  SERVICE_URL="http://127.0.0.1:${VIEWER_PORT}"
fi

json_get() {
  # Accept one or more dot-separated property paths and print the first value
  # present in stdin JSON. Numeric path segments index arrays.
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    for (const path of process.argv.slice(1)) {
      const value = path.split(".").reduce((node, part) => {
        if (node === undefined || node === null) return undefined;
        return node[part];
      }, data);
      if (value === undefined || value === null) continue;
      if (typeof value === "object") console.log(JSON.stringify(value));
      else console.log(String(value));
      process.exit(0);
    }
    process.exit(1);
  ' "$@"
}

api_request() {
  local method="$1" path_value="$2" body="${3:-}"
  local args=(-fsS -X "$method" "$API_BASE$path_value" -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json")
  if [ -n "$body" ]; then
    args+=("--data" "$body")
  fi
  local raw
  raw="$(curl "${args[@]}")"
  local ok
  ok="$(printf '%s' "$raw" | json_get success 2>/dev/null || true)"
  if [ "$ok" != "true" ]; then
    echo "Cloudflare API request failed: $method $path_value" >&2
    printf '%s' "$raw" | node -e '
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      for (const e of data.errors || []) console.error(`- ${e.message || JSON.stringify(e)}`);
    ' >&2 || true
    exit 1
  fi
  printf '%s' "$raw" | json_get result
}

require_hostname() {
  if [ -z "$HOSTNAME_VALUE" ]; then
    echo "ERROR: --hostname is required for this action." >&2
    exit 64
  fi
}

require_token() {
  if [ -n "$API_TOKEN" ]; then
    return
  fi

  if [ "$PROMPT_API_TOKEN" = "1" ] && [ -t 0 ]; then
    printf 'Cloudflare API token: ' >&2
    stty -echo
    trap 'stty echo' INT EXIT
    IFS= read -r API_TOKEN
    stty echo
    trap - INT EXIT
    printf '\n' >&2
  fi

  if [ -z "$API_TOKEN" ]; then
    echo "ERROR: Cloudflare API token required. Pass --api-token, set CLOUDFLARE_API_TOKEN, or use --prompt-api-token." >&2
    exit 64
  fi
}

resolve_zone() {
  if [ -n "$ZONE_ID" ]; then
    return
  fi

  require_hostname
  require_token

  local zones_json
  if [ -n "$ZONE_NAME" ]; then
    zones_json="$(api_request GET "/zones?name=${ZONE_NAME}")"
  else
    zones_json="$(api_request GET "/zones?per_page=50")"
  fi

  local selected
  selected="$(printf '%s' "$zones_json" | HOSTNAME_VALUE="$HOSTNAME_VALUE" node -e '
    const fs = require("fs");
    const zones = JSON.parse(fs.readFileSync(0, "utf8"));
    const host = process.env.HOSTNAME_VALUE;
    const matches = zones
      .filter(z => host === z.name || host.endsWith(`.${z.name}`))
      .sort((a, b) => b.name.length - a.name.length);
    if (!matches.length) process.exit(1);
    console.log(JSON.stringify(matches[0]));
  ')" || {
    echo "ERROR: could not derive Cloudflare zone for $HOSTNAME_VALUE. Pass --zone-id or --zone-name." >&2
    exit 1
  }

  ZONE_ID="$(printf '%s' "$selected" | json_get id)"
  if [ -z "$ACCOUNT_ID" ]; then
    ACCOUNT_ID="$(printf '%s' "$selected" | json_get account.id 2>/dev/null || true)"
  fi
}

resolve_account() {
  if [ -n "$ACCOUNT_ID" ]; then
    return
  fi
  resolve_zone
  if [ -z "$ACCOUNT_ID" ]; then
    echo "ERROR: Cloudflare account ID could not be derived. Pass --account-id." >&2
    exit 64
  fi
}

create_tunnel() {
  require_token
  resolve_account
  local body result
  body="$(TUNNEL_NAME="$TUNNEL_NAME" node -e 'console.log(JSON.stringify({ name: process.env.TUNNEL_NAME, config_src: "local" }))')"
  result="$(api_request POST "/accounts/${ACCOUNT_ID}/cfd_tunnel" "$body")"
  TUNNEL_ID="$(printf '%s' "$result" | json_get id credentials_file.TunnelID)"
  mkdir -p "$(dirname "$CREDENTIALS_PATH")"
  printf '%s' "$result" | json_get credentials_file > "$CREDENTIALS_PATH.tmp"
  install -m 600 "$CREDENTIALS_PATH.tmp" "$CREDENTIALS_PATH"
  rm -f "$CREDENTIALS_PATH.tmp"
  echo "Created tunnel: $TUNNEL_NAME ($TUNNEL_ID)"
}

write_config() {
  require_hostname
  if [ -z "$TUNNEL_ID" ]; then
    echo "ERROR: --write-config requires --tunnel-id or --create-tunnel." >&2
    exit 64
  fi

  mkdir -p "$(dirname "$CONFIG_PATH")"
  if [ -e "$CONFIG_PATH" ]; then
    case "$CONFIG_PATH" in
      *claude-matrix-viewer*) ;;
      *)
        echo "ERROR: refusing to overwrite non-bridge config: $CONFIG_PATH" >&2
        echo "Copy the ingress block below into that config manually." >&2
        exit 1
        ;;
    esac
    cp "$CONFIG_PATH" "$CONFIG_PATH.backup.$(date +%Y%m%d%H%M%S)"
  fi

  cat > "$CONFIG_PATH" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_PATH

ingress:
  - hostname: $HOSTNAME_VALUE
    service: $SERVICE_URL
  - service: http_status:404
EOF
  chmod 600 "$CONFIG_PATH"
  echo "Wrote bridge-managed cloudflared config: $CONFIG_PATH"
}

upsert_dns() {
  require_hostname
  require_token
  resolve_zone

  if [ -z "$TUNNEL_ID" ]; then
    echo "ERROR: --apply-dns requires --tunnel-id or --create-tunnel." >&2
    exit 64
  fi

  local target existing existing_id body
  target="${TUNNEL_ID}.cfargotunnel.com"
  existing="$(api_request GET "/zones/${ZONE_ID}/dns_records?type=CNAME&name=${HOSTNAME_VALUE}")"
  existing_id="$(printf '%s' "$existing" | json_get 0.id 2>/dev/null || true)"
  body="$(HOSTNAME_VALUE="$HOSTNAME_VALUE" TARGET="$target" node -e 'console.log(JSON.stringify({ type: "CNAME", name: process.env.HOSTNAME_VALUE, content: process.env.TARGET, proxied: true }))')"

  if [ -n "$existing_id" ]; then
    api_request PUT "/zones/${ZONE_ID}/dns_records/${existing_id}" "$body" >/dev/null
    echo "Updated DNS: $HOSTNAME_VALUE -> $target"
  else
    api_request POST "/zones/${ZONE_ID}/dns_records" "$body" >/dev/null
    echo "Created DNS: $HOSTNAME_VALUE -> $target"
  fi
}

update_env() {
  require_hostname
  if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: env file not found: $ENV_FILE" >&2
    exit 1
  fi
  KEY="VIEWER_BASE_URL" VALUE="https://${HOSTNAME_VALUE}" ENV_FILE="$ENV_FILE" node <<'NODE'
const fs = require('fs');
const path = process.env.ENV_FILE;
const key = process.env.KEY;
const value = process.env.VALUE;
const lines = fs.readFileSync(path, 'utf8').split(/\n/);
let found = false;
const out = lines.map((line) => {
  if (line.match(new RegExp(`^${key}=`))) {
    found = true;
    return `${key}=${value}`;
  }
  return line;
});
if (!found) out.push(`${key}=${value}`);
fs.writeFileSync(path, out.join('\n').replace(/\n*$/, '\n'));
NODE
  echo "Updated $ENV_FILE: VIEWER_BASE_URL=https://${HOSTNAME_VALUE}"
}

print_detection() {
  echo "=== Cloudflare detection ==="
  if command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared: $(command -v cloudflared)"
    if cloudflared tunnel list >/dev/null 2>&1; then
      echo "login: cloudflared tunnel list succeeded"
    else
      echo "login: cloudflared tunnel list did not succeed"
    fi
  else
    echo "cloudflared: not found"
  fi

  for path_value in \
    "$HOME/.cloudflared/cert.pem" \
    "$HOME/.cloudflared/config.yml" \
    "$HOME/.cloudflared/config.yaml" \
    "/opt/homebrew/etc/cloudflared/config.yml" \
    "/usr/local/etc/cloudflared/config.yml" \
    "/etc/cloudflared/config.yml"; do
    if [ -e "$path_value" ]; then
      echo "found: $path_value"
    fi
  done

  if command -v launchctl >/dev/null 2>&1; then
    launchctl list 2>/dev/null | awk '/cloudflared|cloudflare/ { print "launchd: " $0 }' || true
  fi

  if pgrep -fl cloudflared >/dev/null 2>&1; then
    pgrep -fl cloudflared | awk '{ print "process: " $0 }'
  fi

  if [ -n "$API_TOKEN" ]; then
    echo "api token: supplied for this run (not persisted)"
  else
    echo "api token: not supplied"
  fi
}

print_guidance() {
  echo
  echo "=== Viewer publishing guidance ==="
  if [ -z "$HOSTNAME_VALUE" ]; then
    echo "Pass --hostname viewer.example.com to print a ready-to-use ingress block."
    return
  fi

  cat <<EOF
Add this ingress rule to an existing tunnel config if you already manage one:

  - hostname: $HOSTNAME_VALUE
    service: $SERVICE_URL

Then set:
  VIEWER_BASE_URL=https://$HOSTNAME_VALUE

After changing .env on macOS, re-run:
  setup/service.sh
EOF
}

print_detection
print_guidance

if [ "$CREATE_TUNNEL" = "1" ]; then
  create_tunnel
fi

if [ "$WRITE_CONFIG" = "1" ]; then
  write_config
fi

if [ "$APPLY_DNS" = "1" ]; then
  upsert_dns
fi

if [ "$APPLY_ENV" = "1" ]; then
  update_env
fi
