import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = fileURLToPath(new URL('../.test-build/edge-routing.test.mjs', import.meta.url));
buildSync({ absWorkingDir: root, entryPoints: ['scripts/edge-routing.test.ts'], bundle: true,
  platform: 'node', format: 'esm', packages: 'external', outfile,
  define: { 'import.meta.env': '{}' },
});
const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
