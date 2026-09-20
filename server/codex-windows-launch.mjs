import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const moduleRequire = createRequire(import.meta.url);
export const WINDOWS_CODEX_EXECUTABLE_ENV = 'THOUGHTDAG_CODEX_EXECUTABLE';
export const WINDOWS_HIDDEN_LAUNCHER_PATH = fileURLToPath(
  new URL('./bin/thoughtdag-hidden-console-launcher.exe', import.meta.url),
);

const WINDOWS_PACKAGES = {
  x64: {
    packageName: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
  },
  arm64: {
    packageName: '@openai/codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
  },
};

export function resolveBundledWindowsCodexExecutable({ arch = process.arch } = {}) {
  const target = WINDOWS_PACKAGES[arch];
  if (!target) throw new Error(`Unsupported Windows Codex architecture: ${arch}`);
  const codexPackageJson = moduleRequire.resolve('@openai/codex/package.json');
  const codexRequire = createRequire(codexPackageJson);
  const platformPackageJson = codexRequire.resolve(`${target.packageName}/package.json`);
  const executable = path.join(
    path.dirname(platformPackageJson),
    'vendor',
    target.triple,
    'bin',
    'codex.exe',
  );
  if (!fs.existsSync(executable)) throw new Error(`Bundled Codex executable is missing: ${executable}`);
  return executable;
}

/**
 * Native Codex starts PowerShell/cmd/git grandchildren. A GUI parent has no
 * console for them to inherit, so Windows otherwise creates a visible conhost
 * window. The launcher owns one hidden console for the complete process tree.
 */
export function windowsCodexLaunch({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  launcherPath = WINDOWS_HIDDEN_LAUNCHER_PATH,
  codexExecutable,
} = {}) {
  if (platform !== 'win32') return null;
  const executable = codexExecutable || resolveBundledWindowsCodexExecutable({ arch });
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`ThoughtDAG hidden-console launcher is missing: ${launcherPath}`);
  }
  const codexPathDirectory = path.join(path.dirname(path.dirname(executable)), 'codex-path');
  if (!fs.existsSync(codexPathDirectory)) {
    throw new Error(`Bundled Codex tool directory is missing: ${codexPathDirectory}`);
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
  const inheritedPath = env[pathKey] ? String(env[pathKey]) : '';
  const runtimeEnv = { ...env };
  runtimeEnv[pathKey] = inheritedPath
    ? `${codexPathDirectory}${path.delimiter}${inheritedPath}`
    : codexPathDirectory;
  return {
    executablePath: launcherPath,
    codexExecutable: executable,
    codexPathDirectory,
    env: {
      ...runtimeEnv,
      [WINDOWS_CODEX_EXECUTABLE_ENV]: executable,
    },
  };
}
