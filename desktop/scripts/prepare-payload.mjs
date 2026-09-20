// Assemble the self-contained runtime the packaged app ships with:
// server.mjs + built dist + the server's OWN production node_modules.
// The root dependencies are dominated by frontend libraries (react,
// canvas, markdown) the server never imports — installing them all
// ballooned the payload to 220MB and dragged native .node binaries in
// (a notarization hazard). So the payload gets a minimal package.json
// holding exactly what server.mjs imports, and installs that.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchCodexSdkSpawn } from '../../scripts/patch-codex-sdk.mjs';
import {
  prepareWindowsLauncher,
  WINDOWS_LAUNCHER_NAME,
} from '../../scripts/prepare-windows-launcher.mjs';

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(desktop);
const payload = path.join(desktop, 'payload');

const option = (name) => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const targetPlatform = option('platform') ?? process.platform;
const targetArch = option('arch') ?? process.arch;
const TARGETS = {
  'linux-x64': {
    packageName: '@openai/codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    executable: 'codex',
  },
  'linux-arm64': {
    packageName: '@openai/codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
    executable: 'codex',
  },
  'darwin-x64': {
    packageName: '@openai/codex-darwin-x64',
    triple: 'x86_64-apple-darwin',
    executable: 'codex',
  },
  'darwin-arm64': {
    packageName: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
    executable: 'codex',
  },
  'win32-x64': {
    packageName: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    executable: 'codex.exe',
  },
  'win32-arm64': {
    packageName: '@openai/codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    executable: 'codex.exe',
  },
};
const target = TARGETS[`${targetPlatform}-${targetArch}`];
if (!target) {
  console.error(`unsupported payload target: ${targetPlatform}-${targetArch}`);
  process.exit(1);
}
if (targetPlatform !== process.platform) {
  console.error(
    `payload target ${targetPlatform} must be prepared on the same OS (current: ${process.platform})`,
  );
  process.exit(1);
}

// Compile the tiny Win32 process-tree launcher before copying server/. It
// gives native Codex and all PowerShell/cmd/git descendants one invisible
// inherited console, preventing the flashes a GUI parent otherwise causes.
if (targetPlatform === 'win32') prepareWindowsLauncher({ platform: targetPlatform });

// Every external runtime package used by server.mjs or its local adapter.
// Transitive dependencies are left to npm and must not be listed here.
const SERVER_DEPS = [
  'express',
  'cors',
  '@openai/codex-sdk',
  'pdfjs-dist',
];

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/ missing — run `npm run build` at the repo root first.');
  process.exit(1);
}

const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dependencies = {};
for (const name of SERVER_DEPS) {
  const declared = rootPkg.dependencies?.[name];
  if (name === '@openai/codex-sdk') {
    const installed = JSON.parse(
      readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    // Keep the SDK and its bundled CLI on the exact version exercised by the
    // root lockfile instead of resolving a newer native binary during release.
    dependencies[name] = installed.version;
  } else if (declared) {
    dependencies[name] = declared;
  } else {
    const installed = JSON.parse(
      readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    dependencies[name] = `^${installed.version}`;
  }
}

rmSync(payload, { recursive: true, force: true });
mkdirSync(payload, { recursive: true });
cpSync(path.join(root, 'server.mjs'), path.join(payload, 'server.mjs'));
for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(path.join(root, notice), path.join(payload, notice));
if (existsSync(path.join(root, 'server'))) {
  cpSync(path.join(root, 'server'), path.join(payload, 'server'), { recursive: true });
}
cpSync(path.join(root, 'dist'), path.join(payload, 'dist'), { recursive: true });
writeFileSync(
  path.join(payload, 'package.json'),
  JSON.stringify({ name: 'thoughtdag-codex-server-payload', private: true, dependencies }, null, 2),
);

console.log(`installing server dependencies for ${targetPlatform}-${targetArch}…`);
// Codex ships its native CLI as a platform-specific optional dependency.
// Explicit OS/CPU flags make the selected package deterministic when macOS
// produces x64 and arm64 artifacts on the same runner.
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmArgs = [
  ...(npmCli ? [npmCli] : []),
  'install',
  '--omit=dev',
  '--include=optional',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--registry=https://registry.npmjs.org',
  `--os=${targetPlatform}`,
  `--cpu=${targetArch}`,
];
const install = spawnSync(npmCommand, npmArgs, {
  cwd: payload,
  stdio: 'inherit',
  // Direct .cmd execution is blocked by recent Node releases. npm scripts
  // expose npm_execpath, so normal builds use node + npm-cli.js without a shell.
  shell: !npmCli && process.platform === 'win32',
});
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);

// pdfjs-dist optionally installs @napi-rs/canvas for image rendering. The
// server already supports text-only PDF extraction without it, while these
// unsigned .node addons would break hardened-runtime packaging. Install all
// optional dependencies so Codex's CLI is present, then remove only this
// known-unneeded native backend before the generic safety check below.
const napiScope = path.join(payload, 'node_modules', '@napi-rs');
if (existsSync(napiScope)) {
  for (const entry of readdirSync(napiScope, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === 'canvas' || entry.name.startsWith('canvas-'))) {
      rmSync(path.join(napiScope, entry.name), { recursive: true, force: true });
      console.log('pruned optional PDF canvas backend:', entry.name);
    }
  }
}

// Keep unsigned Node native addons out of Resources. This pure Node walk is
// intentionally shared by Windows, macOS, and Linux builders.
const findNativeAddons = (dir, found = []) => {
  if (found.length >= 5) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (found.length >= 5) break;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) findNativeAddons(file, found);
    else if (entry.isFile() && entry.name.endsWith('.node')) found.push(file);
  }
  return found;
};
const nativeAddons = findNativeAddons(path.join(payload, 'node_modules'));
if (nativeAddons.length) {
  console.error('native Node addons slipped into the payload:\n' + nativeAddons.join('\n'));
  process.exit(1);
}

// codesign --strict rejects any symlink that leaves the bundle. npm's
// .bin shims are launchers the server never spawns — drop them — and
// absolute or dangling links (npm sometimes writes absolute ones) would
// point outside the .app, so they must not survive either. Plain fs
// walking, because this also runs on the Windows builder.
const pruneUnsafe = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      let ok = !path.isAbsolute(readlinkSync(fp));
      if (ok) { try { statSync(fp); } catch { ok = false; } }
      if (!ok) { rmSync(fp); console.log('pruned unsafe symlink:', fp); }
    } else if (e.isDirectory()) {
      if (e.name === '.bin') rmSync(fp, { recursive: true, force: true });
      else pruneUnsafe(fp);
    }
  }
};
pruneUnsafe(path.join(payload, 'node_modules'));

async function verifyCodexPayload() {
  const payloadRequire = createRequire(path.join(payload, 'package.json'));
  // The SDK deliberately exposes an ESM-only `import` condition, so CJS
  // require.resolve cannot select its entry point. Its pinned package layout
  // has a stable dist/index.js entry that can be imported directly.
  const sdkEntry = path.join(payload, 'node_modules', '@openai', 'codex-sdk', 'dist', 'index.js');
  if (!existsSync(sdkEntry)) throw new Error(`Codex SDK entry missing: ${sdkEntry}`);
  const sdkPatch = patchCodexSdkSpawn(sdkEntry);
  console.log('Codex SDK Windows console fix:', sdkPatch.status);
  const sdk = await import(pathToFileURL(sdkEntry).href);
  if (typeof sdk.Codex !== 'function') {
    throw new Error('@openai/codex-sdk does not export Codex');
  }

  const codexPackageJson = payloadRequire.resolve('@openai/codex/package.json');
  const codexPackage = JSON.parse(readFileSync(codexPackageJson, 'utf8'));
  if (!codexPackage.optionalDependencies?.[target.packageName]) {
    throw new Error(`@openai/codex does not declare ${target.packageName}`);
  }

  const codexRequire = createRequire(codexPackageJson);
  const platformPackageJson = codexRequire.resolve(`${target.packageName}/package.json`);
  const executable = path.join(
    path.dirname(platformPackageJson),
    'vendor',
    target.triple,
    'bin',
    target.executable,
  );
  if (!existsSync(executable) || statSync(executable).size === 0) {
    throw new Error(`Codex CLI missing for ${targetPlatform}-${targetArch}: ${executable}`);
  }

  const hiddenLauncher = path.join(payload, 'server', 'bin', WINDOWS_LAUNCHER_NAME);
  if (targetPlatform === 'win32' && (!existsSync(hiddenLauncher) || statSync(hiddenLauncher).size === 0)) {
    throw new Error(`Hidden Codex process launcher missing: ${hiddenLauncher}`);
  }

  if (targetPlatform === process.platform && targetArch === process.arch) {
    // Constructor resolution exercises the SDK-to-CLI package lookup. Running
    // --version then catches corrupt or non-executable native payloads.
    void new sdk.Codex();
    const version = spawnSync(
      targetPlatform === 'win32' ? hiddenLauncher : executable,
      ['--version'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: targetPlatform === 'win32'
          ? { ...process.env, THOUGHTDAG_CODEX_EXECUTABLE: executable }
          : process.env,
      },
    );
    if (version.status !== 0 || !version.stdout?.includes('codex-cli')) {
      throw new Error(
        `Codex CLI validation failed: ${version.stderr || version.stdout || `exit ${version.status}`}`,
      );
    }
    console.log('Codex CLI:', version.stdout.trim());
  } else {
    console.log(`Codex CLI structure verified for cross-arch target ${targetPlatform}-${targetArch}`);
  }
}

await verifyCodexPayload();
console.log(`payload ready (${targetPlatform}-${targetArch}):`, payload);
