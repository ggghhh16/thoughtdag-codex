# Full feature list

[中文](./features_ZH.md) · [Back to README](../README_EN.md)

## Philosophy

Chat terminals are harnesses for doing: they optimize for handing you an answer and hide everything else. ThoughtDAG is an instrument for thinking: the unit of value is the reasoning structure itself, kept legible, editable and repeatable.

Mind maps are drawn; this map grows. Chat leaves no map at all.

*The graph is acyclic. You are the loop.*

## Canvas & context: the One Rule family

<img src="prune-en.gif" alt="Screen recording: a summary node wired to both the research chain and an off-topic dinner node absorbs the noise; the noise edge is clicked, deleted, and regeneration returns a clean summary" width="100%"/>

- **DAG context engine**: `buildContext()` walks all incoming edges, builds history in topological order
- **Layered context assembly**: materials → reference blocks → the conversation, ordering independent of wiring history (same graph, same prompt)
- **Purple edges** (continue): inherit the full ancestor context
- **Orange solid edges** (explore): select text → branch right with the selection as context; solid always means structural, dashed always means bypass (reference / watch)
- **Reference edges (dashed)**: drop a hand-drawn wire on any node to quote it (Q&A + upstream question trail) without dragging its whole conversation in; depth is a first-class edge property: toggle quote ⇄ full on the selected edge OR in the panel's context tree, and the connect toast prices both options (silent when the source has no chain)
- **Context send preview**: live "~N tok · M messages · K files" plus a materials · references · conversation layer breakdown before asking
- **Click-to-delete edges**: select an edge for a floating delete button; right-click menu works too; Cmd+Z undoes
- **Archive (prune-but-keep)**: dimmed on canvas, excluded from every context walk, restorable; batch via multi-select
- **Merge Synthesis**: box-select nodes → structured synthesis (conclusions / evidence / open questions)
- **Highlight system**: three downstream modes: 📄 Full text / 🏷️ Tag important / ✂️ Highlights only; marks render across lists and tables; stale highlights auto-clean on edit; an all-highlights overview (by time / by node) pinpoints each mark's source node, exports Markdown, and weaves any checked subset into one cited passage
- **Node role system**: per-node system prompt with three modes (inherit / set for next / reset here), `appliedRole` recorded at generation time, radio picker for multi-parent conflicts
- **Role library, user-editable**: built-ins plus your own roles; add, edit and remove in a manager (editing a built-in makes your copy; restore anytime); applied roles stay frozen on their nodes
- **Token counting**: per-node usage display

## Reading & materials

<img src="reading-en.gif" alt="Screen recording: selecting a sentence on the original PDF page, asking about it, the answer streaming into the annotation rail while the passage keeps a bubble mark, then a guided digest with page jumps" width="100%"/>

- **Material reader**: original PDF rendering with a selectable text layer (pdf.js); select → ask lands a branch node with `(p.N)` provenance, and the passage keeps an anchor on the page (highlight wash + a bubble that reopens the thread); canvas nodes carry a p.N chip that jumps back into the reader; extracted-text view for scanned PDFs; a footer thread index tagging each conversation p.N or whole-material; per-material scroll memory
- **Annotation rail**: answers stream beside the document; follow-ups chain onto the thread; selecting inside a rail answer explores (branch of THAT answer) or highlights; thread chips switch conversations, a crosshair jumps to the canvas
- **Answers get the reading loop too**: every response opens reading-size; select to highlight or to branch from that passage, ask follow-ups below, and the viewer swaps to the new node so a whole chain of questions streams in place
- **Guided digest**: one click turns the material into a short structured post in the UI language, with (p.N) jump buttons back into the original pages; the digest is a canvas NODE (versioned on rewrite, model-stamped, wireable downstream as the material's compression); regenerating routes through the digest prompt against the full text
- **Recognize (scanned PDFs)**: per-page vision rewrite into Markdown/LaTeX, editable; external OCR output pastes in
- **Content nodes**: notes (markdown), file nodes with PDF covers, time-stamped link snapshots; paste-driven creation; image auto-reading picks the strongest configured vision model; every material opens in the reader
- **Attachment system**: node-local attachments (drag/paste/upload), inherited include/exclude control, fingerprint dedup, automatic Vision switching for images; PDFs feed context as extracted text and wear their first page as a cover on file nodes
- **Material-first landing**: drop a document on the landing page and it lands as a material node with the reader auto-opened; attachments to the root question stay behind the explicit paperclip

## Map & review

<img src="hero-en.png" alt="ThoughtDAG map view: a waterfall DAG of thought, every plaque badged by cognitive move, with the focus panel showing a node's full answer and its token-priced context chain" width="100%"/>

- **Map mode**: three tiers with hysteresis: full cards → takeaway plaques → glyph seals (one icon per node); seals and edges counter-scale to a fixed screen size (map-pin style), so zooming further out tightens the map instead of shrinking it; nodes awaiting human input keep their working form
- **Typed takeaways**: one conclusion-first line per answer version, auto-classified (✕ ruled out · ⚖ decided · ↩ pivoted · ? open; insight stays unmarked); display layer only, never enters context or fingerprints
- **Staleness tracking**: per-generation upstream fingerprints; amber badges on nodes, dots in the context tree, explicit [Stale] marks in downstream payloads
- **Batch replay**: one click re-runs every stale node in dependency order; confirm dialog with a token estimate; stop anytime
- **Version management**: regenerate in place appends a comparable version (page through, delete, revert; downstream staleness reacts to the active version); "Regenerate as branch" spawns a parallel sibling for A/B runs
- **Topology check-up**: on-demand diagnostics with deterministic findings (residual edges, shadow references, blind-pool breaches, pool asymmetry) plus observations (long chains, open branches, collider continuations); locate + one-click fix
- **Canvas search (toolbar icon or Cmd+F)**: exact search across questions, answers, note bodies, highlights, link titles and material names; while you type, matching nodes stay lit and the rest of the map dims (the searchlight); picking a result flies there, opens the panel and scrolls to the exact match
- **Ancestor edge highlighting**: the selected node's path to root turns gold, others dim

## Generation & automation

- **Streaming responses**: SSE token-by-token rendering with blinking cursor, in node and panel; Stop keeps partial content; failed generations show Retry (errors go to toasts, never into answers)
- **Reviewer preset**: critic role on a sliding red edge; re-critiques each new step automatically, history versioned; reviewers are ordinary nodes (question them, branch from them)
- **Paradigm mode** (entrances temporarily backstage while the running experience is rebuilt; existing paradigm canvases still open): human/prompt steps + material slots; instantiate → cascade → unlock; edit the input + replay = re-run the experiment; bounded reviewer rounds declared in the file
- **Ambient memory**: a background judge classifies durable facts (preference / identity / project) with admission rules in code, visible toast + undo on every write; project entries decay out of context after 45 days; one global switch (default on), manager with category badges, paste-import and JSON export; machine steps and digests stay memory-free
- **Edit everything**: double-click a question to edit it; answers edit via a pencil button beside regenerate and copy (double-click stays a text-selection gesture); text selection toolbar (Branch / Highlight)

## Models & search

- **One Codex runtime, two scoped paths**: foreground Q&A uses official Codex App Server persistent threads; background summaries, memory judgments, condensing, and weaving stay in isolated one-shot SDK threads. The browser stores no provider keys and never falls back silently
- **Graph-aware persistent history**: a card's active answer version maps to one Codex turn and every answer version keeps its own thread/turn IDs. The first ordinary child resumes, siblings and explicit branches fork at the parent turn, and fan-in or an unmapped legacy graph starts anew. If another Codex client has advanced the anchor, the canvas automatically forks there instead of crossing histories
- **Official-client continuation**: on the same machine and Codex configuration/login, persistent foreground tasks are visible and continuable in the official Codex client. This uses the local Codex task store rather than a separate ThoughtDAG sync service
- **Models, reasoning, and speed**: the picker uses the live catalog for the current Codex login, allowing Codex-style model, reasoning-level, and Standard/Fast selection. Fast support and copy come from the live model metadata; unsupported models return to Standard. Each answer version retains provenance, and legacy provider pins fall back safely
- **Native Codex search**: web and scholarly toggles remain; scholarly mode prioritizes arXiv, Semantic Scholar, papers, and primary sources, while search/tool progress continues through the existing stream UI
- **MCP ecosystem**: off by default; setting `CODEX_ENABLE_MCP=true` opts into the user's Codex MCP configuration. Existing SSE tool events show progress without exposing argument or result bodies in status messages
- **Image understanding**: pasted images become request-scoped temporary files for Codex and are removed after success, failure, or cancellation

## Desktop app

- **Runtime included**: the desktop shell starts a loopback Node service and carries the Codex SDK and platform/architecture CLI payload; end users do not install project dependencies
- **Native login reuse**: desktop builds read the native operating-system Codex session; native Windows and WSL sessions are separate
- **Native project folders**: select, switch, or clear the Codex working directory from the project menu; paths are registered locally and generation receives only an opaque project ID
- **Three permission levels**: switch between Read only, Project access, and Full access in the toolbar; the default reliably supports bounded list/read/search, project mode enables project writes/commands with command networking off, and Full access has an orange warning plus confirmation
- **GitHub Dark**: splash, landing, canvas, nodes, menus, dialogs, timeline, code, and tutorial scenes share one GitHub-style dark semantic palette
- **Explicit update boundary**: this fork never checks for or installs upstream ThoughtDAG updates; automatic updates stay disabled until its own signed release repository exists
- **The same safety rails**: the server maps the three-level whitelist to real Codex sandboxes instead of accepting raw low-level settings; model-launched commands inherit only a core environment, background summaries stay read-only, and concurrency/abort/cleanup protections remain
- **No Windows console flashes**: native Codex and all PowerShell, cmd, git, and other console descendants share one invisible console; sandboxed commands also use an invisible desktop, while a Job Object tears down the full tree on cancellation
- **Stable desktop storage origin**: the packaged renderer stays on `127.0.0.1:31173` and performs a one-time merge of canvas and attachment data left under the legacy `31174` origin

## Workbench & data

- **Infinite canvas**: pan, zoom, drag nodes freely (React Flow)
- **Column-Tree auto-layout**: main chain flows down, branches fork right; real measured heights prevent overlap; Tidy layout / Align selection on demand
- **Frames**: labeled colored regions with a navigator jump list; hide-annotations view toggle
- **Focus panel (floating overlay)**: cards-on-wash reading layout over the canvas (which never resizes), context tree grouped by materials / references / conversation, follow-up input; drag-resizable width
- **Markdown + LaTeX**: full markdown, syntax highlighting, inline and block math
- **Multi-select**: box-select nodes: Merge Summary / Merge & Delete / Align / Export / Delete
- **Read-only share links**: one link carries the whole graph (compressed into the URL, no server storage); the viewer walks, zooms and reads but cannot edit; share from the ⋯ menu
- **@-mentions**: type @ in any ask box to reference a node by name; mentions not already upstream get a real dashed reference edge (visible, priced, convertible), upstream ones become precise designators
- **Automatic folder backup**: grant a folder once and every change debounces into a real `.thoughtdag.json` on disk; point it at a synced directory and it doubles as cross-device sync with zero servers; a toolbar control center shows the last write and backs up every canvas on demand
- **Event log**: an append-only record of semantic operations (asks, generations, highlights, archiving, undo) with timestamps, metadata-only; travels in backups, exports as CSV for R/Python analysis
- **Node context menu**: right-click for open panel / reading view / regenerate (in place or as a new node) / copy / duplicate / archive / delete; right-clicking selected text keeps the native menu
- **Data persistence**: IndexedDB auto-save (1s debounce) retains canvases plus per-answer Codex thread/turn IDs; multi-canvas projects survive refresh and can be created, switched, renamed, or deleted
- **Export system**: whole-graph JSON backup and import; context-chain / multi-select Markdown export; memory and roles export too: easy in, easy out
- **Import ChatGPT / Claude exports**: drop conversations.json into Import; edit/regenerate branches are preserved as graph forks, each conversation becomes its own canvas
- **Undo/Redo**: Cmd+Z / Cmd+Shift+Z, full state snapshots
- **Keyboard shortcuts**: Space collapse, R regenerate, arrow keys walk the DAG, Esc steps out (legend in the tutorial)
- **Bilingual UI**: auto-detects browser language, one-click EN/中 switch
- **Built-in tutorial**: a ten-step illustrated hero page, from asking to paradigms
- **Example canvas**: one labeled click on the landing page loads four framed chapters around one everyday question: conversation grammar, materials & references, the ⚖️ context-pruning pair, and a reading loop with a real embedded PDF (anchored question, digest node); every node carries a typed takeaway so zooming out lands on a working map; reload anytime from the landing screen

## Roadmap

**Near term**
- [ ] Save any canvas as a paradigm (reverse instantiation)
- [ ] Attachment blob separation (scaling image-heavy canvases)

**Long term**
- [ ] Run comparison view (same paradigm, N runs side by side)
- [ ] Artifact nodes (file deliverables on canvas, Monaco editor + version history)
- [ ] Async collaboration: share a paradigm, collect runs

## Feedback

ThoughtDAG is an early, actively developed project. This is exactly when feedback matters most:

- 🐛 Report bugs or rough edges in the issue tracker of the repository hosting this fork.
- 💡 Discuss thinking-in-graphs in that repository's Discussions area.
