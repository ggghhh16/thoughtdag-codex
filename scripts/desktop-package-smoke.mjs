import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const executablePath = path.resolve(process.argv[2] || 'desktop/out/win-unpacked/ThoughtDAG Codex.exe');
const projectPath = path.resolve(process.argv[3] || process.cwd());
const packagedSdkEntry = path.join(
  path.dirname(executablePath),
  'resources',
  'payload',
  'node_modules',
  '@openai',
  'codex-sdk',
  'dist',
  'index.js',
);
const packagedAdapter = path.join(
  path.dirname(executablePath), 'resources', 'payload', 'server', 'codex-adapter.mjs',
);
const packagedAppServerClient = path.join(
  path.dirname(executablePath), 'resources', 'payload', 'server', 'codex-app-server-client.mjs',
);
const packagedServer = path.join(
  path.dirname(executablePath), 'resources', 'payload', 'server.mjs',
);
const packagedHiddenLauncher = path.join(
  path.dirname(executablePath),
  'resources',
  'payload',
  'server',
  'bin',
  'thoughtdag-hidden-console-launcher.exe',
);
const packagedProjectMcp = path.join(
  path.dirname(executablePath), 'resources', 'payload', 'server', 'project-files-mcp.mjs',
);
const smokeStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thoughtdag-desktop-smoke-'));
const smokeAppData = path.join(smokeStateRoot, 'AppData', 'Roaming');
const smokeLocalAppData = path.join(smokeStateRoot, 'AppData', 'Local');
fs.mkdirSync(smokeAppData, { recursive: true });
fs.mkdirSync(smokeLocalAppData, { recursive: true });

async function openDesktop() {
  const app = await electron.launch({
    executablePath,
    timeout: 60_000,
    args: [`--user-data-dir=${smokeStateRoot}`],
    // Never read or mutate the user's real selected-project state during a
    // packaged smoke run. CODEX_HOME/USERPROFILE remain unchanged so the
    // real Codex login can still be validated.
    env: {
      ...process.env,
      APPDATA: smokeAppData,
      LOCALAPPDATA: smokeLocalAppData,
    },
  });
  try {
    const window = await app.firstWindow({ timeout: 60_000 });
    await window.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/\?dv=/, { timeout: 60_000 });
    await window.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    await window.waitForFunction(async () => {
      const response = await fetch('/api/models');
      return response.ok;
    }, null, { timeout: 30_000 });
    return { app, window };
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

let first;
let second;
let firstOrigin;
try {
  assert.match(
    fs.readFileSync(packagedSdkEntry, 'utf8'),
    /signal: args\.signal,\n\s+windowsHide: true/,
    'packaged Codex SDK must hide its per-turn Windows console',
  );
  const adapterSource = fs.readFileSync(packagedAdapter, 'utf8');
  assert.match(adapterSource, /default_tools_approval_mode="approve"/);
  assert.match(adapterSource, /sandboxMode: 'workspace-write'/);
  assert.match(adapterSource, /sandboxMode: 'danger-full-access'/);
  assert.match(adapterSource, /shell_environment_policy/);
  assert.match(adapterSource, /service_tier: serviceTier/);
  assert.match(adapterSource, /sandbox_private_desktop: true/);
  assert.match(adapterSource, /codexPathOverride/);
  assert.match(adapterSource, /history\.persistence="save-all"/);
  assert.match(adapterSource, /threadSource: 'vscode'/);
  assert.match(adapterSource, /lastTurnId: normalizedCodexLink\.turnId/);
  assert.match(adapterSource, /historyMode === 'paginated'/);
  assert.match(adapterSource, /listThreadItems/);
  const appServerClientSource = fs.readFileSync(packagedAppServerClient, 'utf8');
  assert.match(appServerClientSource, /\['app-server', '--stdio'\]/);
  assert.match(appServerClientSource, /windowsHide: true/);
  assert.match(appServerClientSource, /thread\/items\/list/);
  assert.ok(fs.statSync(packagedHiddenLauncher).size > 0, 'packaged hidden-console launcher must exist');
  const serverSource = fs.readFileSync(packagedServer, 'utf8');
  assert.equal((serverSource.match(/windowsHide: true/g) || []).length >= 2, true);
  const projectMcpSource = fs.readFileSync(packagedProjectMcp, 'utf8');
  assert.match(projectMcpSource, /readOnlyHint: true/);
  assert.match(projectMcpSource, /destructiveHint: false/);
  first = await openDesktop();
  firstOrigin = new URL(first.window.url()).origin;
  const initialProject = await first.window.evaluate(() => window.desktop.getProjectFolder());
  assert.equal(initialProject, null, 'desktop smoke expects no pre-existing selected project');

  await first.app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, projectPath);

  const selected = await first.window.evaluate(() => window.desktop.selectProjectFolder());
  assert.equal(selected.canceled, false);
  assert.equal(path.resolve(selected.project.path), projectPath);

  const catalog = await first.window.evaluate(async () => fetch('/api/models').then((response) => response.json()));
  assert.equal(catalog.capabilities?.modelSelection, true);
  assert.equal(catalog.capabilities?.reasoningEffort, true);
  assert.equal(catalog.capabilities?.modelSpeed, true);
  assert.equal(catalog.capabilities?.projectDirectories, true);
  assert.deepEqual(catalog.capabilities?.permissionModes, ['readonly', 'workspace', 'full']);
  assert.ok(catalog.models?.some((model) => model.supportedReasoningEfforts?.length > 0));
  assert.ok(catalog.models?.some((model) => model.supportsFastMode === true));

  // Browser JavaScript cannot read local Codex history directly. The trusted
  // preload bridge adds the desktop-only control token in the main process.
  const unauthenticatedHistoryStatus = await first.window.evaluate(
    async () => (await fetch('/api/codex/threads?limit=1')).status,
  );
  assert.equal(unauthenticatedHistoryStatus, 401);
  const historyPage = await first.window.evaluate(
    () => window.desktop.listCodexThreads({ limit: 5, archived: false }),
  );
  assert.ok(Array.isArray(historyPage.threads));
  assert.ok(historyPage.threads.length > 0, 'packaged smoke expects at least one local Codex task');
  let importedHistory;
  for (const summary of historyPage.threads) {
    const candidate = await first.window.evaluate(
      (threadId) => window.desktop.readCodexThread(threadId),
      summary.id,
    );
    if (candidate.thread?.turnCount > 0) {
      importedHistory = candidate.thread;
      break;
    }
  }
  assert.ok(importedHistory, 'packaged smoke expects one task with a completed text turn');
  assert.equal(importedHistory.turnCount, importedHistory.turns.length);
  assert.ok(importedHistory.turns.every((turn) => turn.userText && turn.assistantText));
  const archivedHistoryPage = await first.window.evaluate(
    () => window.desktop.listCodexThreads({ limit: 5, archived: true }),
  );
  assert.ok(Array.isArray(archivedHistoryPage.threads));

  // A fresh smoke profile opens the first-run tutorial. Close that top layer
  // before exercising toolbar controls underneath it.
  await first.window.locator('div.fixed.inset-0[class~="z-[95]"]').waitFor({ state: 'visible', timeout: 5_000 });
  await first.window.keyboard.press('Escape');
  await first.window.locator('div.fixed.inset-0[class~="z-[95]"]').waitFor({ state: 'detached', timeout: 5_000 });

  const speedPicker = first.window.locator('[data-model-speed-picker]');
  await speedPicker.waitFor({ state: 'visible' });
  assert.equal(await first.window.evaluate(() => localStorage.getItem('thoughtdag.modelSpeed')), null);
  await speedPicker.locator('button').first().click();
  await speedPicker.locator('button').nth(2).click();
  assert.equal(await first.window.evaluate(() => localStorage.getItem('thoughtdag.modelSpeed')), 'fast');
  await first.window.locator('div.fixed.inset-0[class~="z-[95]"]').waitFor({ state: 'detached' }).catch(() => {});
  const permissionPicker = first.window.locator('[data-permission-picker]');
  await permissionPicker.waitFor({ state: 'visible' });
  assert.equal(await first.window.evaluate(() => localStorage.getItem('thoughtdag.permissionMode')), null);
  assert.match(await permissionPicker.locator('button').first().innerText(), /只读访问|Read only/);
  await permissionPicker.locator('button').first().click();
  await permissionPicker.locator('button').nth(2).click();
  assert.equal(await first.window.evaluate(() => localStorage.getItem('thoughtdag.permissionMode')), 'workspace');
  await permissionPicker.locator('button').first().click();
  await permissionPicker.locator('button').nth(3).click();
  assert.equal(await first.window.evaluate(() => localStorage.getItem('thoughtdag.permissionMode')), 'workspace');
  await first.window.keyboard.press('Escape');

  const invalidPermission = await first.window.evaluate(async () => {
    const response = await fetch('/api/codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'validation only' }],
        permissionMode: 'invalid-mode',
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(invalidPermission.status, 400);
  assert.equal(invalidPermission.body.code, 'INVALID_PERMISSION_MODE');

  const invalidSpeed = await first.window.evaluate(async () => {
    const response = await fetch('/api/codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'validation only' }],
        modelSpeed: 'turbo',
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(invalidSpeed.status, 400);
  assert.equal(invalidSpeed.body.code, 'INVALID_MODEL_SPEED');

  await first.app.close();
  first = null;

  second = await openDesktop();
  const secondOrigin = new URL(second.window.url()).origin;
  assert.equal(secondOrigin, firstOrigin, 'desktop renderer origin must stay stable across restarts');
  assert.equal(await second.window.evaluate(() => localStorage.getItem('thoughtdag.permissionMode')), 'workspace');
  assert.equal(await second.window.evaluate(() => localStorage.getItem('thoughtdag.modelSpeed')), 'fast');
  const restored = await second.window.evaluate(() => window.desktop.getProjectFolder());
  assert.equal(path.resolve(restored.path), projectPath);

  await second.window.evaluate(() => window.desktop.clearProjectFolder());
  const cleared = await second.window.evaluate(() => window.desktop.getProjectFolder());
  assert.equal(cleared, null);

  console.log(JSON.stringify({
    executablePath,
    projectPath,
    restored: true,
    cleared: true,
    modelCount: catalog.models.length,
    importedHistoryTurns: importedHistory.turnCount,
    archivedHistoryVisible: archivedHistoryPage.threads.length > 0,
    fastModePersisted: true,
    hiddenConsoleLauncher: true,
  }, null, 2));
} finally {
  await first?.app.close().catch(() => {});
  await second?.app.close().catch(() => {});
  fs.rmSync(smokeStateRoot, { recursive: true, force: true });
}
