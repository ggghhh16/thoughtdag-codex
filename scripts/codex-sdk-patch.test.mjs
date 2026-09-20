import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { patchCodexSdkSpawn } from './patch-codex-sdk.mjs';

const unpatchedFixture = [
  'const child = spawn(this.executablePath, commandArgs, {',
  '      env,',
  '      signal: args.signal',
  '    });',
].join('\n');

test('patches the Codex SDK turn process to hide its Windows console', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'thoughtdag-sdk-patch-'));
  const sdkEntry = path.join(directory, 'index.js');
  try {
    fs.writeFileSync(sdkEntry, unpatchedFixture, 'utf8');
    assert.equal(patchCodexSdkSpawn(sdkEntry).status, 'patched');
    assert.match(fs.readFileSync(sdkEntry, 'utf8'), /signal: args\.signal,\n\s+windowsHide: true/);
    assert.equal(patchCodexSdkSpawn(sdkEntry).status, 'already-patched');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed when the pinned SDK spawn layout changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'thoughtdag-sdk-patch-'));
  const sdkEntry = path.join(directory, 'index.js');
  try {
    fs.writeFileSync(sdkEntry, 'export const changed = true;\n', 'utf8');
    assert.throws(
      () => patchCodexSdkSpawn(sdkEntry),
      /Unsupported @openai\/codex-sdk spawn layout/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
