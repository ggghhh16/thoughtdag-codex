# ThoughtDAG Codex

**A local Codex workspace with an editable conversation canvas.**

Branch a Codex conversation, attach source material, choose the context for the next question, and continue a task from the graph. ThoughtDAG Codex connects the ThoughtDAG canvas to the official Codex App Server and SDK.

This is an independently maintained community derivative of [ThoughtDAG](https://github.com/chenxiachan/thoughtdag), not an official OpenAI application or an upstream ThoughtDAG release.

[中文说明](README_ZH.md) · [Setup](docs/setup.md) · [Security](SECURITY.md) · [Upstream](https://github.com/chenxiachan/thoughtdag)

## What this version does

- **Run Codex from the canvas.** Foreground answers use persistent Codex threads; background summaries use isolated SDK calls.
- **Continue and branch tasks.** Continue the main conversation or fork at an earlier answer. Multiple incoming paths start a new thread with the selected graph context.
- **Import local Codex conversations.** The desktop app lists and imports local tasks. On the same computer and configuration, compatible persistent tasks can also be continued from another Codex client.
- **Choose a project and permissions.** The desktop folder picker connects a local project. Read only is the default; project access and full access are explicit choices.
- **Use the models available to your login.** Model, reasoning level and Fast availability come from the runtime; the app does not unlock unavailable account capabilities.
- **Keep the canvas tools.** Attach PDF, DOCX, images, HTML or web snapshots; edit answers, retain answer versions, arrange branches, and export graph backups or Markdown.

### Relationship to ThoughtDAG

| Area | This Codex integration |
| --- | --- |
| Foundation | Reuses ThoughtDAG's canvas, document reader and graph interactions |
| Execution | Uses a local Codex runtime; browser provider-key management is removed |
| Task storage | Canvas data lives in local IndexedDB; persistent Codex tasks also live in the local Codex task store |
| Distribution | Maintained and versioned separately; does not use upstream's updater or installers |
| Hosting | Static hosting is a read-only viewer; it cannot run local Codex |

For a new task, the graph selects the supplied context. Resuming a persistent Codex task also retains that task's tool and media history, which may not all be visible in canvas cards. Structural branches and changed paths are handled by the adapter; this is not a claim that every runtime state is represented by a graph edge.

## Run from source

Requirements: Node.js **22.12+**, npm, and a Codex login or your own `CODEX_API_KEY`. Model access and usage limits follow that account. Optional Poppler (`pdftoppm` on PATH) enables server-side PDF page images.

```bash
git clone https://github.com/ggghhh16/thoughtdag-codex.git
cd thoughtdag-codex
npm ci
npm run codex:login
npm run server
```

In a second terminal, in the same directory:

```bash
npm run dev
```

Open <http://localhost:5173>. Use `npm run codex:status` to check authentication. The pinned runtime reuses the local Codex login/configuration; credentials are not included in this repository. Put optional overrides in a local `.env` based on [.env.example](.env.example).

### Desktop development

```bash
npm --prefix desktop ci
npm run desktop
```

This builds the frontend and starts Electron. Native folder selection and local task import are desktop features. Packaging commands and platform requirements are in [desktop/README.md](desktop/README.md). Source publication does not imply a current, signed installer is available; use only assets released by this repository.

## Permissions and data

| Mode | Behavior |
| --- | --- |
| Read only (default) | Local shell/edit tools are disabled; the built-in project reader excludes common credential files and stays inside the selected root |
| Project access | Local commands can write the selected project and a temporary workspace; command network access is disabled. This is a write boundary, not a guarantee that other host files are unreadable |
| Full access | Local tools can access host files and the network; the UI asks for confirmation |

External MCP integration is **off by default**. It requires `CODEX_ENABLE_MCP=true` and the canvas MCP toggle. External tools have their own capabilities and are not confined by the command filesystem sandbox.

- Canvases and attachments are stored locally. Context, selected attachments and permitted tool results can be sent to the configured Codex service when you ask a question.
- Web snapshots contact their source websites. HTML reader snapshots block scripts and remote subresources; a page may therefore look different from the live website.
- The HTTP server binds only to loopback and rejects untrusted Host/Origin values. It is a single-user local application, **not an authenticated multi-user server**; local programs running as your user remain trusted.
- Backups, exports and share links can contain conversation/document content. Review them before sharing.
- Runtime configuration, credentials, `.env` files, local conversations and build caches are excluded from publication. See [SECURITY.md](SECURITY.md) for the review scope and limitations.

## Development checks

```bash
npm test
npm run build
npm audit
npm --prefix desktop audit
```

Tests use local fixtures and do not consume model usage. A real model call requires a separately authenticated session. UI smoke tests are available in `scripts/` and may require a Chrome installation.

## Credits and license

Based on [ThoughtDAG](https://github.com/chenxiachan/thoughtdag) by Xia Chen. The original copyright and [MIT license](LICENSE) are preserved. The official Codex components retain their own licenses, including Apache-2.0 for the SDK. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
