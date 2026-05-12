# magi-assistant-wiki

Wiki Assistant agent sidecar for the Hyperon Wiki right column. Lane B of the [Right Column Implementation Plan](https://github.com/Magi-AGI/hyperon-wiki/blob/main/docs/RIGHT-COLUMN-IMPLEMENTATION-PLAN.md) (sibling to `magi-playground-wiki`).

**Status**: scaffold (R3 — Assistant agent MVP).

## What it does

Proxies chat input from the wiki's right-column chat panel to a Claude agent (Anthropic API) configured with the [`hyperon-wiki-mcp`](https://github.com/Magi-AGI/hyperon-wiki-mcp) read-tool surface. The agent is system-prompted to navigate the wiki and to funnel deeper / out-of-scope questions to [ASI Create](https://create.singularitynet.io/) rather than confabulating (plan invariant I-6).

```
Browser → POST /api/assistant/chat → SSE stream
            ↓
        Express agent sidecar (this repo)
            ↓
        @anthropic-ai/claude-agent-sdk
            ↓
        Anthropic Messages API (claude-sonnet-4-6)
            ↓ tool_use
        hyperon-wiki-mcp (stdio subprocess, Ruby MCP server)
            ↓ tool_result
        Anthropic → SSE deltas back to browser
```

## V1 scope (what's locked)

- **Read-only.** Tool allowlist: `search_cards`, `get_card`, `list_children`, `get_relationships`. NO write/admin tools.
- **Model**: `claude-sonnet-4-6` only. Haiku rejected for V1 — underperforms on tool-orchestration. Opus rejected to cap cost.
- **Stateless.** No server-side conversation memory; the browser sends the full message history on each call.
- **Tiered limits**:
  - Anonymous: 10 chats/IP/min (Nginx), 6k token input cap (this sidecar).
  - Signed-in: 60 chats/user/min, 16k token input cap. Detection via `_hyperon_session` cookie.
- **Wall-clock**: 30s hard budget per turn.
- **Telemetry**: structured JSON to stdout. NO chat content logged (plan I-7).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/assistant/chat` | SSE-streamed agent turn |
| `GET`  | `/api/assistant/health` | Readiness/liveness |

### POST /api/assistant/chat

**Request**:
```json
{
  "messages": [{"role": "user", "content": "What is MeTTa?"}],
  "model": "claude-sonnet-4-6"
}
```

**Response**: `text/event-stream` of events:

```
data: {"type":"delta","text":"MeTTa is..."}

data: {"type":"tool_use","name":"mcp__hyperon-wiki__search_cards"}

data: {"type":"delta","text":" the native language..."}

data: {"type":"done","turn_id":"t_..."}
```

On Anthropic API failure (timeout / 5xx / rate limit), the stream still emits a single fallback `delta` + `done` (per plan B-8, I-9):

```
data: {"type":"delta","text":"I can't reach the language model right now. ..."}
data: {"type":"done","turn_id":"t_...","fallback":true}
```

## Local dev

Prereqs: Node 20+, Ruby (for the MCP subprocess), npm.

```bash
cp .env.example .env
# Fill in ANTHROPIC_API_KEY and MCP_API_KEY (or MCP_USERNAME+MCP_PASSWORD)

npm install
npm run dev
```

Sanity test:

```bash
curl -s http://localhost:8766/api/assistant/health | jq
```

Streamed chat:

```bash
curl -N -s -X POST http://localhost:8766/api/assistant/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What is PeTTa?"}]}'
```

## Tests

```bash
npm test
```

V1 covers token-budget math; integration tests against a real MCP subprocess + Anthropic API are deferred to R5 (requires the EC2 service-account credentials).

## Deploy

Sibling to Decko/Nginx on the EC2 host. Nginx routes:

```nginx
location /api/assistant/ {
    proxy_pass http://127.0.0.1:8766/api/assistant/;
    proxy_buffering off;             # SSE
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 35s;          # > AGENT_TIMEOUT_MS=30s
}
```

Rate limits (plan B-7) belong upstream of this service in the Nginx config — keyed by `$cookie__hyperon_session` first, fallback to `$binary_remote_addr`.

## Layout

```
magi-assistant-wiki/
├── README.md
├── .env.example
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── index.ts              # Express server entry
│   ├── config.ts             # env-driven config + model allowlist
│   ├── agent/
│   │   ├── agent.ts          # Agent SDK + MCP stdio subprocess + tool allowlist
│   │   └── prompt.ts         # locked V1 system prompt
│   ├── routes/
│   │   ├── chat.ts           # POST /api/assistant/chat (SSE)
│   │   └── health.ts         # GET /api/assistant/health
│   └── middleware/
│       └── token-budget.ts   # cheap chars/4 token estimator
└── tests/
    └── token-budget.test.ts
```

## Cross-references

- [Right Column Implementation Plan](https://wiki.magi-agi.org/Neoterics+Magus+Hyperon_Wiki_Right_Column_Plan) — Magi Archive card 17242.
- [magi-playground-wiki](https://github.com/Magi-AGI/magi-playground-wiki) — Lane A (MeTTa Playground sidecar).
- [hyperon-wiki-mcp](https://github.com/Magi-AGI/hyperon-wiki-mcp) — the MCP server this agent spawns.

## License

MIT.
