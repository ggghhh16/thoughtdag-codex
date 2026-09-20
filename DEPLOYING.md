# Deployment boundaries

ThoughtDAG Codex has two deliberately different deployment modes.

## Local or desktop: full product

The full application requires a trusted Node.js host that can spawn the Codex runtime and access the current user's Codex login cache:

```bash
npm install
npm run codex:login
npm run server
npm run dev
```

The Express service binds to loopback. Do not expose its generation endpoints directly to the internet: they would otherwise grant unauthenticated use of the host's Codex account.

## Static or edge hosting: read-only canvas

Cloudflare Pages, Workers, and comparable edge runtimes cannot spawn the local Codex process. The included Pages Function therefore keeps read-only canvas/fetch support but returns an explicit `501 local-only` response for generation, model probing, runtime credentials, and Codex status.

You may still deploy `dist/` as a static viewer:

```bash
npm ci
npm run build
```

Do not add a silent legacy-provider fallback to the hosted build. A remote full deployment would need a separate authenticated, rate-limited, audited execution service on a trusted Node host; that architecture is intentionally outside this local-first fork.
