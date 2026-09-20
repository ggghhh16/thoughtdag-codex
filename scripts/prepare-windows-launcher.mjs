import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptsDirectory);
export const WINDOWS_LAUNCHER_NAME = 'thoughtdag-hidden-console-launcher.exe';
export const WINDOWS_LAUNCHER_PATH = path.join(root, 'server', 'bin', WINDOWS_LAUNCHER_NAME);

export function prepareWindowsLauncher({ platform = process.platform } = {}) {
  if (platform !== 'win32') return { status: 'not-required', path: null };
  const compilerCandidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const compiler = compilerCandidates.find(existsSync);
  if (!compiler) throw new Error('Windows .NET Framework C# compiler is unavailable.');

  mkdirSync(path.dirname(WINDOWS_LAUNCHER_PATH), { recursive: true });
  const source = path.join(scriptsDirectory, 'windows-hidden-console-launcher.cs');
  const compile = spawnSync(compiler, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    `/out:${WINDOWS_LAUNCHER_PATH}`,
    source,
  ], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) {
    throw new Error(`Windows hidden-console launcher compilation failed:\n${compile.stdout || ''}${compile.stderr || ''}`);
  }
  if (!existsSync(WINDOWS_LAUNCHER_PATH) || statSync(WINDOWS_LAUNCHER_PATH).size === 0) {
    throw new Error('Windows hidden-console launcher was not created.');
  }
  return { status: 'prepared', path: WINDOWS_LAUNCHER_PATH };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = prepareWindowsLauncher();
  console.log(`ThoughtDAG hidden-console launcher: ${result.status}${result.path ? ` (${result.path})` : ''}`);
}
