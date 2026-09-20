import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1600, height: 1050 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('thoughtdag.seeded', 'yes');
    localStorage.setItem('thoughtdag.tutorialDone', 'yes');
    localStorage.setItem('thoughtdag.lang', 'zh');
  });
  const code = 'function greet() {\n\tconst message = "中文 <tag> & spaces  ";\n\n  return message;\n}\n';
  const response = '```javascript\n' + code + '```';
  const payload = { nodes: [{ id: 'copy-test', type: 'thought', dragHandle: '.drag-handle', position: { x: 0, y: 0 }, data: { question: '代码复制测试', response, responses: [response], responseIndex: 0, highlights: [], isRoot: true } }], edges: [] };
  const hash = deflateRawSync(JSON.stringify(payload)).toString('base64url');
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#view=${hash}`);
  await page.evaluate(() => {
    window.realWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.realExecCommand = document.execCommand.bind(document);
  });
  const button = page.locator('[data-id="copy-test"] pre').locator('..').getByRole('button');
  await button.waitFor();
  const click = async () => { await button.hover(); await button.click(); };
  const copied = async () => page.waitForFunction(() => !!document.querySelector('[data-id="copy-test"] .lucide-check'));
  // Windows clipboard uses CRLF; indentation and all other characters must match.
  const read = async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n');
  await click(); await copied();
  assert.equal(await read(), code);
  console.log('NATIVE_COPY_EXACT_TEXT_OK');

  for (const mode of ['rejected', 'missing']) {
    await page.evaluate(mode => {
      window.execCopies = 0;
      navigator.clipboard.writeText = mode === 'missing' ? undefined : async () => { throw new DOMException('Write permission denied', 'NotAllowedError'); };
      document.execCommand = (...args) => { window.execCopies++; return window.realExecCommand(...args); };
    }, mode);
    await click(); await copied();
    assert.equal(await read(), code);
    assert.equal(await page.evaluate(() => window.execCopies), 1);
    assert.equal(await page.locator('body > textarea').count(), 0);
    console.log(`${mode.toUpperCase()}_API_FALLBACK_EXACT_TEXT_OK`);
  }

  await page.evaluate(() => {
    navigator.clipboard.writeText = () => new Promise(resolve => { window.finishCopy = resolve; });
  });
  await click();
  assert.equal(await button.locator('.lucide-check').count(), 0, 'pending copy must not show success');
  await page.evaluate(() => window.finishCopy()); await copied();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
    document.execCommand = () => false;
  });
  await click();
  await page.getByText('复制失败，请选中代码后按 Ctrl+C（Mac：⌘C）复制。', { exact: true }).waitFor();
  assert.equal(await button.locator('.lucide-check').count(), 0, 'failed copy must not show success');
  assert.equal(await page.locator('body > textarea').count(), 0);
  console.log('PENDING_AND_FAILURE_FEEDBACK_OK');

  // Fallback must preserve the active editor, its selection and the viewport.
  const helper = ts.transpileModule(readFileSync('src/lib/clipboard.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace('export async function copyText', 'async function copyText');
  const restored = await page.evaluate(async helper => {
    const copyText = new Function(helper + '; return copyText;')();
    document.execCommand = window.realExecCommand;
    const editor = document.createElement('textarea');
    document.body.appendChild(editor);
    editor.value = 'keep selection'; editor.focus(); editor.setSelectionRange(2, 7, 'backward');
    const before = { x: scrollX, y: scrollY };
    await copyText('restore-test');
    const result = { focused: document.activeElement === editor, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, scrolled: scrollX !== before.x || scrollY !== before.y };
    editor.remove();
    return result;
  }, helper);
  assert.deepEqual(restored, { focused: true, start: 2, end: 7, direction: 'backward', scrolled: false });
  assert.deepEqual(errors, []);
  console.log('FOCUS_SELECTION_SCROLL_RESTORED_OK');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
