import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSdkEntry = path.join(
  path.dirname(scriptDirectory),
  'node_modules',
  '@openai',
  'codex-sdk',
  'dist',
  'index.js',
);

const unpatchedSpawn = [
  'const child = spawn(this.executablePath, commandArgs, {',
  '      env,',
  '      signal: args.signal',
  '    });',
].join('\n');

const hiddenSpawn = [
  'const child = spawn(this.executablePath, commandArgs, {',
  '      env,',
  '      signal: args.signal,',
  '      windowsHide: true',
  '    });',
].join('\n');

/**
 * Codex SDK 0.151.0 launches the native Windows CLI once per turn. Without
 * windowsHide, a packaged GUI application gets a transient console window.
 * Keep the patch exact and fail loudly if the pinned SDK layout ever drifts.
 */
export function patchCodexSdkSpawn(sdkEntry = defaultSdkEntry) {
  const source = fs.readFileSync(sdkEntry, 'utf8');
  if (source.includes(hiddenSpawn)) return { status: 'already-patched', sdkEntry };
  if (!source.includes(unpatchedSpawn)) {
    throw new Error(`Unsupported @openai/codex-sdk spawn layout: ${sdkEntry}`);
  }
  fs.writeFileSync(sdkEntry, source.replace(unpatchedSpawn, hiddenSpawn), 'utf8');
  return { status: 'patched', sdkEntry };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const result = patchCodexSdkSpawn(process.argv[2] ? path.resolve(process.argv[2]) : defaultSdkEntry);
  console.log(`Codex SDK Windows console fix: ${result.status} (${result.sdkEntry})`);
}
