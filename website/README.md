# ThoughtDAG Codex product story

This directory preserves the upstream bilingual, scroll-driven product story and adapts its visible setup/download boundary for the Codex fork. The context semantics remain unchanged: solid edges carry full context, branches are explicit, and deleting an edge changes the next request.

The source repository is https://github.com/ggghhh16/thoughtdag-codex; no public viewer or signed installer feed is configured. The page is deliberately `noindex`, its download section shows source commands, and upstream GitHub links are labeled as upstream. Before publishing it under a new origin:

1. replace canonical, alternate-language, Open Graph, and JSON-LD URLs;
2. regenerate `robots.txt` and `sitemap.xml` for that origin;
3. configure this fork's own release/download links only after signed artifacts exist;
4. never point the Codex fork's updater at the upstream ThoughtDAG release feed.

Preview from the repository root:

```bash
python -m http.server 4175
```

Then open <http://127.0.0.1:4175/website/>. English is the default; add `?lang=zh` or use the language toggle for Chinese.

The context-repair story and benchmark pages are retained as upstream research material. Their source links intentionally continue to point at the upstream repository.
