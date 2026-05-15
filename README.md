# claude-matrix-bridge

Bridge Matrix messages directly to Claude Code CLI sessions. Uses Claude Code's `--print` mode with structured JSON streaming — no TUI scraping, no ANSI stripping. Per-session rooms can use Matrix E2EE when `ENCRYPT_SESSION_ROOMS=1`.

## License

This project is licensed under AGPLv3. For alternative licensing, contact [licensing@matron.chat](mailto:licensing@matron.chat).

## Requirements

- Node.js 22+ (matrix-js-sdk 41.x uses `Promise.withResolvers`, which only landed in v22)
- Claude Code CLI installed and authenticated
- A Matrix homeserver, such as [matron-server](https://github.com/matronhq/matron-server), Matron's branch of Tuwunel, with a bot account

**Linux (Ubuntu/Debian):** `apt-get install nodejs npm` (or use nvm). For voice notes: `setup/install-whisper.sh` will install the rest.

**macOS:** [Homebrew](https://brew.sh), Xcode Command Line Tools (`xcode-select --install`), and `brew install node@22`. For voice notes: `setup/install-whisper.sh` will run `brew install whisper-cpp ffmpeg` automatically.

For public file and secret viewer links on macOS, install `cloudflared` if you want to publish the local viewer through Cloudflare Tunnel:

```bash
brew install cloudflared
```

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — add your MATRIX_ACCESS_TOKEN and ALLOWED_USER_IDS
npm start
```

To run as a managed service, use the OS-detecting installer:

```bash
setup/install.sh                # installs npm deps, seeds .env
# edit .env, or import a bot blob:
node setup/import-bot-blob.mjs 'db1:...'

# macOS can import during install:
setup/install.sh --blob 'db1:...'

# Linux (systemd):
sudo setup/service.sh

# macOS (LaunchAgent — runs while you're logged in):
setup/service.sh
# or, system-wide LaunchDaemon (runs at boot, requires sudo):
sudo SCOPE=system setup/service.sh
```

After editing `.env`, re-run `setup/service.sh` (on macOS, launchd has no
`EnvironmentFile` equivalent — values are inlined into the plist at install
time).

## Publishing The Viewer On macOS

The macOS service installer starts both the Matrix bridge and the local file viewer. The viewer listens on `127.0.0.1:$MATRIX_VIEWER_PORT` and powers file links, secure secret requests, and one-time sensitive-data links.

To make those links usable from Matrix clients, set `VIEWER_BASE_URL` to a public HTTPS URL that forwards to the local viewer. The Cloudflare helper is dry-run by default and is careful around existing tunnel setups:

```bash
setup/cloudflare.sh --hostname viewer.example.com
```

If you already have a tunnel on the machine, copy the printed ingress rule into your existing cloudflared config:

```yaml
- hostname: viewer.example.com
  service: http://127.0.0.1:9803
```

Then set the bridge URL and reload launchd environment values:

```bash
setup/cloudflare.sh --hostname viewer.example.com --apply-env
setup/service.sh
```

For API-backed DNS or tunnel work, pass a one-shot Cloudflare token. The helper does not persist the token:

```bash
CLOUDFLARE_API_TOKEN=... setup/cloudflare.sh \
  --hostname viewer.example.com \
  --tunnel-id <tunnel-id> \
  --apply-dns
```

To create a bridge-managed tunnel config instead of editing an existing one:

```bash
CLOUDFLARE_API_TOKEN=... setup/cloudflare.sh \
  --hostname viewer.example.com \
  --create-tunnel \
  --write-config \
  --apply-dns \
  --apply-env
```

That writes only bridge-managed files under `~/.cloudflared` by default. Existing non-bridge cloudflared configs are reported but not overwritten.

## Managing The Service

**Linux (systemd):**

| Action | Command |
|---|---|
| Status | `systemctl status claude-matrix-bridge` |
| Restart | `sudo systemctl restart claude-matrix-bridge` |
| Logs | `journalctl -u claude-matrix-bridge -f` |
| Stop | `sudo systemctl stop claude-matrix-bridge` |

**macOS (launchd, user scope):**

| Action | Command |
|---|---|
| Status | `launchctl print gui/$UID/chat.matron.claude-matrix-bridge \| head -20` |
| Restart | `launchctl kickstart -k gui/$UID/chat.matron.claude-matrix-bridge` |
| Logs | `tail -f ~/Library/Logs/claude-matrix-bridge.log` |
| Stop | `launchctl kill TERM gui/$UID/chat.matron.claude-matrix-bridge` |
| Uninstall | `launchctl bootout gui/$UID/chat.matron.claude-matrix-bridge && rm ~/Library/LaunchAgents/chat.matron.claude-matrix-bridge.plist` |

For `SCOPE=system` setups, replace `gui/$UID` with `system` and `~/Library/LaunchAgents` with `/Library/LaunchDaemons`.

## Config (.env)

| Variable | Description | Default |
|---|---|---|
| `MATRIX_HOMESERVER_URL` | Matrix homeserver URL (required) | `http://localhost:6167` |
| `MATRIX_ACCESS_TOKEN` | Bot account access token (required) | — |
| `MATRIX_BOT_USER_ID` | Imported bot user ID from an add-bot blob, used for first-start bootstrap when `MATRIX_ACCESS_TOKEN` is empty | — |
| `MATRIX_BOT_PASSWORD` | Imported bot password from an add-bot blob | — |
| `MATRIX_BOT_RECOVERY_KEY` | Imported bot recovery key from an add-bot blob | — |
| `BRIDGE_ROOM_ID` | Imported bridge room ID from an add-bot blob, used by helper tools | — |
| `ALLOWED_USER_IDS` | Comma-separated Matrix user IDs (e.g. `@alice:matron.chat`) | `""` (any user) |
| `DEFAULT_WORKDIR` | Default working directory for Claude Code sessions; `~` expands to the service user's home directory | `process.cwd()` if unset |
| `SESSION_TIMEOUT` | Session timeout in ms | `3600000` (1 hour) |
| `ENCRYPT_SESSION_ROOMS` | Set to `0` to create unencrypted per-session rooms. Unset or `1` creates encrypted per-session rooms. | enabled |
| `BRIDGE_CLAUDE_MD_PATH` | Optional markdown file appended to bridge-spawned Claude sessions for bridge-specific guidance | `BRIDGE_CLAUDE.md` |
| `DEBUG` | Set to `1` to log raw JSON events from Claude Code | `0` |
| `HMAC_SECRET` | Shared secret for signed file viewer URLs | — |
| `VIEWER_BASE_URL` | Public URL for file viewer | — |
| `LINK_EXPIRY_MS` | Signed URL expiry in ms | `900000` (15 min) |
| `MATRIX_BRIDGE_API_PORT` | Internal API port (hooks, MCP, viewer) | `9802` |
| `MATRIX_VIEWER_PORT` | Local file viewer port | `9803` |

## Commands

| Command | Description |
|---|---|
| `!start [workdir]` | Start a Claude Code session (optional custom workdir) |
| `!start now` | Start a fresh session (skip resume offer) |
| `!stop` | Stop the current session |
| `!restart` | Stop and immediately resume the session |
| `!resume [n\|id]` | Resume a previous session |
| `!sessions` | List all past sessions |
| `!workdir <path>` | Change working directory (restarts session) |
| `!status` | Show session info (uptime, workdir, restarts) |
| `!working` | Toggle tool call visibility |
| `!mcp` | Show MCP server status |
| `!model` | Show current model info |
| `!cost` | Show session cost |
| `!usage` | Show token usage stats |
| `!tools` | List available tools |
| `!help` | Show available commands |

Any other message is forwarded directly to Claude Code. Claude Code slash commands (e.g. `/commit`, `/review-pr`) are passed through directly.

## How it works

1. Matrix messages arrive via `matrix-bot-sdk`
2. Claude Code is spawned with `--print --input-format stream-json --output-format stream-json`
3. User messages are sent as JSON on stdin
4. Structured JSON events are parsed from stdout — response text is extracted from `assistant` and `result` events
5. The complete response is sent to the Matrix room when a `result` event arrives (turn complete)
6. Long responses are split at 32K-char boundaries
7. Sessions persist across restarts via `--resume <session-id>`
8. Crashed sessions auto-restart up to 3 times
9. Messages sent while Claude is busy are queued and sent when the turn completes

## File structure

```
claude-matrix-bridge/
├── index.js              # Main bridge
├── ask-user.js           # MCP server for user questions
├── BRIDGE_CLAUDE.md      # Extra instructions for bridge-spawned Claude sessions
├── mcp-config.json       # MCP server config for Claude Code
├── viewer/
│   └── server.js         # HMAC-signed file viewer
├── setup/
│   ├── install.sh        # OS-dispatching installer
│   ├── service.sh        # OS-dispatching service installer
│   ├── import-bot-blob.mjs
│   └── cloudflare.sh     # macOS Cloudflare viewer helper
├── package.json
├── .env.example
└── README.md
```
