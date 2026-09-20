import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const outfile = fileURLToPath(new URL('node_modules/.tmp/markdown-marks.test.mjs', root));
buildSync({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['scripts/markdown-marks.test.tsx'],
  bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', outfile,
  define: { 'import.meta.env.DEV': 'false' },
  // The production language store reads localStorage during module loading.
  banner: { js: 'globalThis.window = {}; globalThis.localStorage = { getItem: () => "zh", setItem: () => {} };' },
});
const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
