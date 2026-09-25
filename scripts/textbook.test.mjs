import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { location: { hash: '', origin: 'http://localhost', search: '' }, setTimeout, clearTimeout };
const vite = await createServer({ configFile: false, cacheDir: '.test-cache', server: { middlewareMode: true, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { createAnchor, createCitation, resolveAnchor, markdownHeadings } = await vite.ssrLoadModule('/src/lib/textbook.ts');
const { sourceTextMap, rehypeSource } = await vite.ssrLoadModule('/src/lib/rehype-source.ts');
const { buildContext } = await vite.ssrLoadModule('/src/store/context-builder.ts');
const { codexLinkForGeneration } = await vite.ssrLoadModule('/src/store/streaming.ts');
const require = createRequire(import.meta.url);
const { createTextbookFiles } = require('../desktop/textbook-files.js');
const { dockBounds } = require('../desktop/textbook-window.js');
const source = '# 第一章\n\n## 一节\n\n开头。\n\n重复句子。\n\n后面内容。\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\n## 二节\n\n其他上下文。\n\n重复句子。\n\n结尾。\n';
const doc = { id: 'doc', libraryId: 'lib', relativePath: 'chapter.md', version: 'v1', content: source, marks: [] };
const first = createAnchor(doc, source.indexOf('重复句子'), source.indexOf('重复句子') + 5);
const second = createAnchor(doc, source.lastIndexOf('重复句子'), source.lastIndexOf('重复句子') + 5);
const node = (id, patch = {}) => ({ id, type: 'thought', position: { x: 0, y: 0 }, data: { question: id, response: '', responses: [], responseIndex: -1, attachments: [], highlights: [], ...patch } });
const citation = createCitation('material', first, 'nearby');
const nodes = [node('material', { stepKind: 'note', textbook: doc, question: source }), node('a', { sourceCitation: citation, response: 'answer-A', responses: ['answer-A'], responseIndex: 0, codexThreadIds: ['hidden-thread'], codexTurnIds: ['turn-a'] }), node('b', { sourceCitation: createCitation('material', second, 'nearby'), response: 'answer-B' }), node('follow')];
const edges = [{ source: 'material', target: 'a', data: { isCrossLink: true, sourceCitation: {} } }, { source: 'material', target: 'b', data: { isCrossLink: true, sourceCitation: {} } }, { source: 'a', target: 'follow' }];

test('same phrase resolves to selected occurrence, independent of layout', () => {
  assert.equal(resolveAnchor(second, source, 'v1').start, source.lastIndexOf('重复句子'));
  assert.equal(resolveAnchor(first, source, 'v1').start, source.indexOf('重复句子'));
});
test('cross-paragraph selections preserve exact source and full touched blocks', () => {
  const anchor = createAnchor(doc, source.indexOf('句子'), source.indexOf('后面内容') + 2);
  assert.equal(anchor.text, source.slice(anchor.start, anchor.end));
  assert.match(createCitation('material', anchor, 'nearby').content, /重复句子。\n\n后面内容。/);
});
test('partial code selection includes entire fenced code', () => {
  const start = source.indexOf('x =');
  const c = createCitation('material', createAnchor(doc, start, start + 5), 'nearby');
  assert.match(c.content, /```js\nconst x = 1;\nconsole.log\(x\);\n```/);
  assert.equal(c.anchor.text, 'x = 1');
  assert.doesNotMatch(c.content, /其他上下文/);
});
test('nearby, section and chapter scopes obey section boundaries without truncation', () => {
  assert.doesNotMatch(citation.content, /其他上下文|第一章/);
  const section = createCitation('material', first, 'section');
  assert.match(section.content, /## 一节/); assert.doesNotMatch(section.content, /## 二节/);
  assert.equal(createCitation('material', first, 'chapter').content, source);
});
test('changed files relocate only when surrounding evidence is unique', () => {
  const updated = 'new preface\n'.repeat(10) + source;
  assert.equal(resolveAnchor(second, updated, 'v2').start, updated.lastIndexOf('重复句子'));
  assert.equal(resolveAnchor(second, source.replace('结尾。', '已修改。'), 'v2'), null);
  assert.equal(resolveAnchor(first, source + source, 'v3'), null);
  assert.equal(first.snapshot, source);
});
test('two questions have isolated actual prompt messages, no whole chapter inherited', () => {
  const a = JSON.stringify(buildContext('a', nodes, edges).messages);
  const b = JSON.stringify(buildContext('b', nodes, edges).messages);
  assert.doesNotMatch(a, /其他上下文|answer-B/); assert.doesNotMatch(b, /answer-A|console.log/);
  assert.match(a, /Actual selection/); assert.match(a, /version=v1/);
});
test('follow-up carries only its branch and starts a clean persistent thread', () => {
  const text = JSON.stringify(buildContext('follow', nodes, edges).messages);
  assert.match(text, /answer-A/); assert.doesNotMatch(text, /answer-B|其他上下文/);
  assert.deepEqual(codexLinkForGeneration('follow', nodes, edges), { mode: 'start' });
  assert.deepEqual(codexLinkForGeneration('a', nodes, edges), { mode: 'start' });
});
test('explicit question reference is included while ordinary persistent resume still works', () => {
  const refs = [...edges, { source: 'b', target: 'follow', data: { isCrossLink: true } }];
  assert.match(JSON.stringify(buildContext('follow', nodes, refs).messages), /answer-B/);
  const ordinary = [node('p', { responses: ['hello'], responseIndex: 0, codexThreadIds: ['thread'], codexTurnIds: ['turn'] }), node('c')];
  assert.deepEqual(codexLinkForGeneration('c', ordinary, [{ source: 'p', target: 'c' }]), { mode: 'resume', threadId: 'thread', turnId: 'turn' });
});
test('JSON round trip preserves original citation and source link metadata', () => {
  const copy = JSON.parse(JSON.stringify({ nodes, edges }));
  assert.deepEqual(copy.nodes[1].data.sourceCitation, citation);
  assert.equal(resolveAnchor(copy.nodes[2].data.sourceCitation.anchor, source, 'v1').start, second.start);
  assert.deepEqual(buildContext('follow', copy.nodes, copy.edges), buildContext('follow', nodes, edges));
});
test('native file reads, save conflict, images, relink and folder boundaries', () => {
  const dir = fs.mkdtempSync(path.resolve('.textbook-files-test-'));
  try {
    const root = path.join(dir, 'book'); fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'chapter.md'), '\ufeff# 标题\r\n');
    fs.writeFileSync(path.join(root, 'sub', 'next.md'), '# next');
    fs.writeFileSync(path.join(root, 'image.png'), 'fake-image');
    fs.writeFileSync(path.join(dir, 'outside.md'), 'secret');
    const files = createTextbookFiles(path.join(dir, 'registry.json'));
    const { id } = files.register(root);
    assert.deepEqual(files.list(id), ['chapter.md', 'sub/next.md']);
    const initial = files.read(id, 'chapter.md');
    const saved = files.save(id, 'chapter.md', initial.version, '# new\n');
    assert.equal(saved.content, '# new\n');
    fs.writeFileSync(path.join(root, 'chapter.md'), 'external update');
    assert.throws(() => files.save(id, 'chapter.md', saved.version, 'lost update'), /外部修改/);
    assert.equal(files.read(id, 'chapter.md').content, 'external update');
    assert.throws(() => files.read(id, '../outside.md'), /所选教材/);
    assert.throws(() => files.read(id, path.join(dir, 'outside.md')), /相对路径/);
    assert.match(files.image(id, 'image.png'), /^data:image\/png;base64,/);
    assert.equal(createTextbookFiles(path.join(dir, 'registry.json')).read(id, 'sub/next.md').content, '# next');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('docking stays accessible on small and negative-coordinate displays', () => {
  for (const area of [{ x: 0, y: 0, width: 800, height: 600 }, { x: -1920, y: -200, width: 1920, height: 1080 }]) {
    const b = dockBounds({ x: area.x, y: area.y - 500, width: 1500, height: 1200 }, area, 480);
    assert.ok(b.x >= area.x && b.y >= area.y);
    assert.ok(b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height);
  }
});

test('rendered source boundaries preserve escapes, entities and CRLF', () => {
  assert.deepEqual(sourceTextMap('A &amp; B', 'A & B'), [0,1,2,7,8,9]);
  assert.deepEqual(sourceTextMap('a\\*b', 'a*b'), [0,1,3,4]);
  assert.deepEqual(sourceTextMap('a\r\nb', 'a\nb'), [0,1,3,4]);
  assert.equal(sourceTextMap('different', 'text'), null);
});

test('syntax-highlighted code maps source positions in LF and CRLF documents', async () => {
  const { unified } = await import('unified');
  const { default: parse } = await import('remark-parse');
  const { default: toHast } = await import('remark-rehype');
  const { default: highlight } = await import('rehype-highlight');
  for (const newline of ['\n', '\r\n']) {
    const source = ['# Title', '', '```js', 'const answer = 42;', 'console.log(answer);', '```'].join(newline);
    const processor = unified().use(parse).use(toHast).use(highlight).use(rehypeSource, { source });
    const tree = await processor.run(processor.parse(source));
    const spans = [];
    const walk = n => { if (n.properties?.['data-md-start'] !== undefined) spans.push(n); n.children?.forEach(walk); };
    walk(tree);
    const codeSpans = spans.filter(n => n.properties['data-md-start'] > source.indexOf('```js'));
    assert.ok(codeSpans.length >= 4, 'code must carry positions after syntax highlighting');
    for (const span of codeSpans) {
      assert.equal(source.slice(span.properties['data-md-start'], span.properties['data-md-end']).replaceAll('\r\n','\n'), span.children[0].value);
    }
  }
});

test('outline parses heading hierarchy and exact repeated-title offsets, excludes fenced headings', () => {
  const text = '# **总览**\r\n\r\n## 相同标题\r\n\r\n#### [细节](next.md)\r\n\r\n```md\r\n## 假标题\r\n```\r\n\r\n## 相同标题\r\n\r\n小节\r\n----\r\n\r\n###### `末级`\r\n';
  const h = markdownHeadings(text);
  assert.deepEqual(h.map(n => n.title), ['总览', '相同标题', '细节', '相同标题', '小节', '末级']);
  assert.deepEqual(h.map(n => n.depth), [1, 2, 4, 2, 2, 6]);
  assert.equal(h[2].parentId, h[1].id);
  assert.equal(h[3].parentId, h[0].id);
  assert.equal(h[5].parentId, h[4].id);
  assert.notEqual(h[1].id, h[3].id);
  assert.equal(h[3].start, text.lastIndexOf('## 相同标题'));
  assert.equal(h[4].start, text.indexOf('小节'));
  assert.deepEqual(markdownHeadings('plain text\n\n```md\n# not a heading\n```'), []);
});

test('reader English catalog covers UI labels and native error prefixes', async () => {
  const { readerText, readerMessages } = await vite.ssrLoadModule('/src/i18n/reader.ts');
  const { useI18n } = await vite.ssrLoadModule('/src/i18n/index.ts');
  const previous = useI18n.getState().lang;
  useI18n.setState({ lang: 'en' });
  for (const [zh, en] of Object.entries(readerMessages)) {
    assert.equal(readerText(zh), en);
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/);
  }
  assert.equal(readerText('Error: 文件已被外部修改，未覆盖。请保留草稿，重新读取后合并。'), 'Error: The file changed externally and was not overwritten. Keep your draft, reload, and merge changes.');
  useI18n.setState({ lang: 'zh' });
  assert.equal(readerText('原文已变化'), '原文已变化');
  useI18n.setState({ lang: previous });
});
