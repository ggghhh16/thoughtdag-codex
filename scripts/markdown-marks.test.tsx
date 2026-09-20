import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromHtml } from 'hast-util-from-html';
import type { Element, Nodes } from 'hast';
import { HighlightedMarkdown, Markdown } from '../src/components/Markdown';

const code = 'public class Main {\n    public static void main(String[] args) {\n        int score = 85;\n        System.out.println(score >= 60 ? "及格" : "不及格");\n    }\n}';
const trace = (text: string) => ({ text, nodeId: 'node-test', title: '探索 "代码" <test>' });
const render = (content: string, selections: string[] = [], highlights: string[] = []) => renderToStaticMarkup(createElement(HighlightedMarkdown, {
  content, highlights: new Set(highlights), exploreMarks: selections.map(trace),
}));
function elements(html: string, tag: string) {
  const result: Element[] = [];
  const visit = (node: Nodes) => {
    if (node.type === 'element' && node.tagName === tag) result.push(node);
    if ('children' in node) node.children.forEach(visit);
  };
  visit(fromHtml(html, { fragment: true }));
  return result;
}
const textOf = (node: Nodes): string => node.type === 'text' ? node.value : 'children' in node ? node.children.map(textOf).join('') : '';

test('fenced Java exploration preserves complete code and syntax highlighting', () => {
  const source = `先用固定分数表示出来：\n\n\`\`\`java\n${code}\n\`\`\``;
  const html = render(source, [code]);
  assert.equal(textOf(elements(html, 'pre')[0]), code + '\n');
  assert.ok(elements(html, 'mark').length > 0);
  assert.match(html, /hljs-keyword/);
  assert.doesNotMatch(html, /&lt;mark/);
  for (const mark of elements(html, 'mark')) {
    assert.equal(mark.properties.dataExploreTarget, 'node-test');
    assert.equal(mark.properties.title, trace('').title);
  }
});

test('inline, indented, tilde, longer and streaming fences retain literal code', () => {
  for (const source of ['Use `score >= 60` now.', '    score >= 60\n', '~~~java\nscore >= 60\n~~~', '````java\nscore >= 60\n```\n````', '```java\nscore >= 60']) {
    const baseline = renderToStaticMarkup(createElement(Markdown, { children: source }));
    const html = render(source, ['score >= 60']);
    assert.deepEqual(elements(html, 'code').map(textOf), elements(baseline, 'code').map(textOf));
    assert.ok(elements(html, 'mark').length > 0);
    assert.doesNotMatch(html, /&lt;mark/);
  }
});

test('selection across prose and a code block preserves both', () => {
  const html = render('先判断：\n\n```java\nscore >= 60\n```\n\n然后输出。', ['先判断：\nscore >= 60\n然后输出。']);
  assert.equal(textOf(elements(html, 'pre')[0]), 'score >= 60\n');
  assert.equal(elements(html, 'p').length, 2);
  assert.equal(elements(html, 'mark').map(textOf).join('').replace(/\s/g, ''), '先判断：score>=60然后输出。');
});

test('bold, lists, links and table cells remain structurally valid', () => {
  const html = render('**加粗** 与 [链接](https://example.com)\n\n- 第一项\n- 第二项\n\n| 名称 | 值 |\n|---|---|\n| 分数 | 85 |', ['加粗 与 链接', '第一项\n第二项', '名称\t值\n分数\t85']);
  assert.equal(elements(html, 'strong').length, 1);
  assert.equal(elements(html, 'a')[0].properties.href, 'https://example.com');
  assert.equal(elements(html, 'li').length, 2);
  assert.equal(elements(html, 'td').length, 2);
  assert.ok(elements(html, 'mark').map(textOf).join('').includes('分数85'));
});

test('highlights outrank overlapping exploration marks and handle repeated code', () => {
  const html = render('`score` and `score`', ['score'], ['score']);
  assert.equal(elements(html, 'mark').length, 2);
  assert.doesNotMatch(html, /explore-mark/);
  assert.equal(elements(html, 'code').map(textOf).join(','), 'score,score');
});

test('HTML examples stay literal and mark metadata cannot create attributes', () => {
  const source = '```html\n<mark title="example">text</mark>\n```';
  const html = render(source, ['<mark title="example">text</mark>']);
  assert.equal(textOf(elements(html, 'pre')[0]), '<mark title="example">text</mark>\n');
  assert.ok(elements(html, 'mark').length > 0);
  assert.equal(elements(html, 'test').length, 0);
});

test('math and unmarked content retain their rendering', () => {
  const source = 'Formula $x + 1$ and normal text.';
  const baseline = renderToStaticMarkup(createElement(Markdown, { children: source }));
  assert.equal(render(source), baseline);
  const marked = render(source, ['normal text']);
  assert.match(marked, /class="katex"/);
  assert.equal(elements(marked, 'mark').map(textOf).join(''), 'normal text');
});


test('untrusted raw HTML cannot add forms, frames, styles or active handlers', () => {
  const html = render('<iframe src="http://localhost:3001"></iframe><form action="https://example.com"><input name="secret"></form><style>body{display:none}</style><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">link</a>');
  assert.doesNotMatch(html, /<(iframe|form|style|script)\b/i);
  assert.doesNotMatch(html, /onerror=|javascript:/i);
  for (const input of elements(html, 'input')) {
    assert.equal(input.properties.disabled, true);
    assert.equal(input.properties.type, 'checkbox');
  }
});
