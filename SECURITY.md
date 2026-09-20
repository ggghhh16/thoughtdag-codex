# Security model

ThoughtDAG Codex is a single-user local application. It is not designed to expose a Codex account or project filesystem over a public, shared, tunneled or reverse-proxied HTTP endpoint. Do not forward its local port to other users.

## Boundaries

- The backend accepts only loopback binding, validates Host and exact browser origins, rejects cross-origin form requests, and requires JSON for mutation requests. Desktop project registration and task history also require a process-scoped token, held by the Electron main process.
- These controls defend against unrelated websites, not malicious software already running as the same OS user. Read only disables local shell/edit tools; project access restricts writes but is not a complete read-isolation boundary. Full access deliberately grants broad tool capabilities.
- External MCP is disabled unless explicitly enabled by the operator and in the UI. External services, plugins and tools have independent permissions. Review them before enabling.
- URL snapshots validate DNS results, pin validated addresses for the connection, revalidate each redirect, and stop reading responses above 8 MiB. Non-public/literal destinations are rejected. Fake-IP DNS support is an explicit local proxy opt-in and weakens destination classification: enable it only with a trusted proxy.
- Raw Markdown HTML is sanitized before highlighting/math rendering. HTML document frames are sanitized, script-disabled, and cannot fetch remote resources. This is defense in depth, not a promise that every possible malicious document format is harmless.
- Backups and share links contain user content. Do not publish them without reviewing their contents. Codex may retain local thread history separately from canvas storage.

## Publication hygiene

Never commit `.env`, Codex auth/configuration, browser cookies, API keys, private keys, real conversation exports, project selection state, caches, or installer staging directories. Sample config files must use placeholders. Upstream research/marketing assets are provenance materials, not this fork's benchmark results or current feature claims.

Checks for a release:

```bash
npm test
npm run build
npm audit
npm --prefix desktop audit
```

Run a secret scan over the intended Git history and inspect package contents before distributing a new installer. `npm audit` covers known registry advisories; zero findings is not a full security guarantee. Signing, notarization, penetration testing, and live validation of every external tool are separate checks.

## Reporting

For non-sensitive problems, use this repository's issues. Do not include credentials, private paths, conversation exports or exploitable private details in a public issue. Use GitHub private vulnerability reporting if enabled; otherwise ask the maintainer for a private reporting channel without posting the vulnerability details.
