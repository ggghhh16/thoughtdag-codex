import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  WINDOWS_CODEX_EXECUTABLE_ENV,
  WINDOWS_HIDDEN_LAUNCHER_PATH,
} from '../server/codex-windows-launch.mjs';

function consoleProbe(label) {
  return [
    'Add-Type -Name Native -Namespace ThoughtDAGProbe -MemberDefinition',
    `'[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);'`,
    '; $handle=[ThoughtDAGProbe.Native]::GetConsoleWindow()',
    `; Write-Output ('${label}=' + $handle + ';visible=' + [ThoughtDAGProbe.Native]::IsWindowVisible($handle))`,
  ].join(' ');
}

test('Windows launcher gives Codex and console grandchildren one invisible inherited console', {
  skip: process.platform !== 'win32',
}, async () => {
  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const nested = Buffer.from(consoleProbe('nested'), 'utf16le').toString('base64');
  const parent = [
    consoleProbe('parent'),
    `; & '${powershell.replaceAll("'", "''")}' -NoLogo -NoProfile -NonInteractive -EncodedCommand '${nested}'`,
  ].join('');
  const child = spawn(WINDOWS_HIDDEN_LAUNCHER_PATH, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parent,
  ], {
    env: { ...process.env, [WINDOWS_CODEX_EXECUTABLE_ENV]: powershell },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, stderr);
  const entries = [...stdout.matchAll(/(parent|nested)=(\d+);visible=(True|False)/g)];
  assert.equal(entries.length, 2, stdout);
  assert.notEqual(entries[0][2], '0', 'parent must own a console for descendants to inherit');
  assert.equal(entries[0][2], entries[1][2], 'nested shell must inherit the same console');
  assert.deepEqual(entries.map((entry) => entry[3]), ['False', 'False']);
});

test('closing the Windows launcher job terminates console grandchildren', {
  skip: process.platform !== 'win32',
}, async () => {
  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = [
    `$nested=Start-Process -FilePath '${powershell.replaceAll("'", "''")}' `,
    "-ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru",
    '; Write-Output $nested.Id; [Console]::Out.Flush(); Start-Sleep -Seconds 30',
  ].join('');
  const launcher = spawn(WINDOWS_HIDDEN_LAUNCHER_PATH, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    env: { ...process.env, [WINDOWS_CODEX_EXECUTABLE_ENV]: powershell },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const nestedPid = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('nested process did not start')), 5_000);
    launcher.once('error', reject);
    launcher.stdout.on('data', (chunk) => {
      buffered += chunk;
      const match = buffered.match(/\b(\d+)\s*\r?\n/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });
  assert.equal(Number.isInteger(nestedPid), true);
  launcher.kill();
  await new Promise((resolve) => launcher.once('exit', resolve));

  const deadline = Date.now() + 2_000;
  let running = true;
  while (running && Date.now() < deadline) {
    try {
      process.kill(nestedPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      running = false;
    }
  }
  assert.equal(running, false, `nested process ${nestedPid} survived launcher termination`);
});
