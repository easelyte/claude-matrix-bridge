# claude-matrix-bridge

Bridge Matrix messages directly to Claude Code CLI sessions. Uses Claude Code's `--print` mode with structured JSON streaming — no TUI scraping, no ANSI stripping. E2E encrypted via Matrix.

## Requirements

- Node.js 20+
- Claude Code CLI installed and authenticated
- A Matrix homeserver (e.g. Tuwunel) with a bot account

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — add your MATRIX_ACCESS_TOKEN and ALLOWED_USER_IDS
npm start
```

## Config (.env)

| Variable | Description | Default |
|---|---|---|
| `MATRIX_HOMESERVER_URL` | Matrix homeserver URL (required) | `http://localhost:6167` |
| `MATRIX_ACCESS_TOKEN` | Bot account access token (required) | — |
| `ALLOWED_USER_IDS` | Comma-separated Matrix user IDs (e.g. `@alice:matron.chat`) | `""` (any user) |
| `DEFAULT_WORKDIR` | Default working directory for Claude Code sessions | `process.cwd()` |
| `SESSION_TIMEOUT` | Session timeout in ms | `3600000` (1 hour) |
| `DEBUG` | Set to `1` to log raw JSON events from Claude Code | `0` |
| `HMAC_SECRET` | Shared secret for signed file viewer URLs | — |
| `VIEWER_BASE_URL` | Public URL for file viewer | — |
| `LINK_EXPIRY_MS` | Signed URL expiry in ms | `900000` (15 min) |
| `API_PORT` | MCP question API port | `9802` |
| `PORT` | File viewer port | `9803` |

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
├── ask-matrix-user.js    # MCP server for user questions
├── mcp-config.json       # MCP server config for Claude Code
├── viewer/
│   └── server.js         # HMAC-signed file viewer
├── setup/
│   ├── install.sh        # npm install + .env setup
│   └── systemd.sh        # Create systemd services
├── package.json
├── .env.example
└── README.md
```
