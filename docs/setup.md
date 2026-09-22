# Codex setup and architecture

[中文](./setup_ZH.md) · [Back to README](../README_EN.md)

## Requirements

- Node.js 22.12 or newer
- npm
- An authenticated Codex session or `CODEX_API_KEY`

Codex App Server and the Codex SDK run in a local Node process. Pure static hosts and edge runtimes such as Cloudflare Workers cannot generate answers because they cannot spawn the Codex runtime.

## Run from source

```bash
npm install
npm run codex:login
npm run codex:status
npm run server
```

In another terminal:

```bash
npm run dev
```

Open <http://localhost:5173>. The Codex status entry reports ready, not logged in, or unavailable. Tokens, API keys, and auth-file contents are never returned to the browser.

To use an API key instead of interactive login, copy `.env.example` to `.env` and set `CODEX_API_KEY`. Optional settings:

| Variable | Purpose |
|----------|---------|
| `PORT` | Local proxy port; default `3001` |
| `VITE_PUBLIC_VIEWER_ORIGIN` | Optional read-only share host; current origin by default |
| `CODEX_HOME` | Use another Codex configuration directory |
| `CODEX_ENABLE_MCP` | Set `true` to inherit user Codex MCP servers; off by default |
| `CODEX_MAX_CONCURRENCY` | Concurrent generations, 1–8; default 3 |

Restart `npm run server` after changing environment variables.

## How graph cards map to Codex tasks

Foreground Q&A uses persistent threads through the official Codex App Server. A card's active question/answer version maps to one turn, and every answer version stores its own Codex thread and turn IDs. The mapping preserves the DAG semantics rather than treating the latest task as one linear chat:

- The first ordinary child resumes the parent's thread.
- Another child of the same parent, or an explicit branch, forks the parent's thread at that exact parent turn.
- Fan-in and legacy canvases without Codex IDs start a new thread seeded from the context selected by the current wires.
- Before resuming, the adapter checks the anchor. If the official Codex client has appended turns after it, ThoughtDAG forks at the anchor instead of joining the two histories.

Background summaries, memory judgments, condensing, and similar machine tasks are not part of the visible Q&A path. They continue to use isolated, one-shot SDK threads.

```text
React canvas
  -> buildContext() walks the wired DAG
  -> POST /api/stream (SSE) for foreground Q&A
  -> App Server start / resume / fork + one persisted turn
  -> POST /api/codex for an isolated non-streaming background task
```

On the same machine, using the same `CODEX_HOME` and login, these persisted foreground tasks are available to view and continue in the official Codex client. ThoughtDAG relies on the local Codex task store; it does not promise its own cross-device sync or visibility between different configuration directories.

Codex defaults to a read-only sandbox with `approvalPolicy: "never"`. Without a selected project, the working directory is a request-scoped empty temporary directory. The desktop project menu can select, switch, or clear a native folder, then the toolbar chooses the boundary: Read only exposes bounded list/read/search MCP tools; Project access enables commands and adds only the selected project as a durable write root while command networking remains off; Full access removes filesystem/network sandboxing and requires a second confirmation. Read-only and project modes disable project instruction loading; full access can load local instructions, skills and hooks. Command environments use the runtime core environment policy. Background calls are separate threads and should not be treated as a stronger permission boundary than the selected mode. Images use a separate temporary directory and are removed after completion, failure, or cancellation.

Global MCP servers are not inherited by default because external tools sit outside the filesystem sandbox and may have side effects. They require both `CODEX_ENABLE_MCP=true` and the canvas MCP toggle. Enable them only after auditing and trusting the active Codex configuration; `codex.config.example.toml` contains an optional mock-server example.

## Model and web search

The UI reads the live Codex App Server model catalog for the current login, including the default model, reasoning levels, and speed capabilities. Switching models resets an incompatible effort to Auto; Fast maps to Codex's priority service tier, Standard explicitly maps to default, and a model without Fast support safely runs at Standard. The server validates every selection again before generation. Legacy provider pins in imported canvases fall back safely without rewriting historical content or provenance.

The canvas web-search toggle maps to Codex web search. Availability still depends on local Codex configuration, account, and policy. The app never silently falls back to an old provider or a browser-direct completion endpoint.

## Data, authentication, and desktop builds

- Canvases and the per-answer Codex thread/turn IDs remain in browser IndexedDB and retain `.thoughtdag.json` import/export compatibility.
- The packaged desktop renderer uses the fixed loopback origin `http://127.0.0.1:31173`. On upgrade it performs a one-time merge of canvas and attachment records left under the legacy `31174` origin, so a transient port change no longer makes projects appear missing.
- `#view=` payloads remain in the URL fragment. Without a configured public viewer, source-build links are intentionally local to the current origin; set `VITE_PUBLIC_VIEWER_ORIGIN` after publishing your own read-only host.
- Documents are not sent to a hosted ThoughtDAG service. Only wire-selected text and request images enter the local Codex call path.
- Source and desktop builds reuse the native Windows/macOS/Linux Codex login cache. Native Windows and WSL use different user directories; log in from the same environment that launches the app.
- Only paths returned by the desktop native folder picker are registered with the local backend. The renderer and generation API receive a session-scoped opaque project ID, which expires when the service restarts.
- The local service is loopback-only and must not be exposed directly to the public internet.

## Verification

```bash
npm run test:codex   # deterministic fake stream; consumes no quota
npm run build
# While both `npm run server` and `npm run dev` are running:
npm run smoke
```

A live answer requires a successful `npm run codex:status`. When logged out, the status endpoint and generation error are explicit and never switch models silently.

## Local HTTP and proxy settings

The server rejects non-loopback `HOST` values. Browser origins are limited to the server itself and loopback ports 5173/4173. For another development port, set an exact `THOUGHTDAG_ALLOWED_ORIGINS` value as shown in `.env.example`. This does not enable remote hosting. If a trusted local proxy uses fake-IP DNS, explicitly set `THOUGHTDAG_ALLOW_FAKE_IP=true`; leave it disabled on ordinary DNS.
