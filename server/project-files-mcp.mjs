import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_LIST_ENTRIES = 200;
const MAX_READ_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 1_000;
const MAX_READ_CHARS = 200_000;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 100;

const BLOCKED_DIRECTORIES = new Set([
  '.git',
  '.codex',
  '.claude',
  '.ssh',
  'node_modules',
]);

const SAFE_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

export class ProjectFilesError extends Error {
  constructor(message, code = 'PROJECT_FILES_ERROR') {
    super(message);
    this.name = 'ProjectFilesError';
    this.code = code;
  }
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function portableRelative(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative ? relative.split(path.sep).join('/') : '.';
}

function isBlockedFileName(name) {
  const lower = name.toLowerCase();
  if (SAFE_ENV_TEMPLATES.has(lower)) return false;
  return lower === '.env'
    || lower.startsWith('.env.')
    || ['.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json'].includes(lower)
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)
    || /\.(pem|key|p12|pfx|keystore)$/.test(lower);
}

function isBlockedRelative(relativePath, { directory = false } = {}) {
  if (relativePath === '.') return false;
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.some((part) => BLOCKED_DIRECTORIES.has(part.toLowerCase()))) return true;
  return !directory && isBlockedFileName(parts.at(-1) || '');
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number.isInteger(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function decodeText(buffer) {
  if (buffer.includes(0)) throw new ProjectFilesError('Binary files cannot be read.', 'BINARY_FILE');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ProjectFilesError('Only UTF-8 text files can be read.', 'UNSUPPORTED_ENCODING');
  }
}

export async function createProjectFilesService(rootPath, { fsPromises = fs.promises } = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    throw new ProjectFilesError('A canonical absolute project root is required.', 'INVALID_ROOT');
  }
  const root = await fsPromises.realpath(rootPath);
  const rootStats = await fsPromises.stat(root);
  if (!rootStats.isDirectory()) throw new ProjectFilesError('The project root is not a directory.', 'INVALID_ROOT');

  const resolveExisting = async (requested = '.', expectedType) => {
    if (typeof requested !== 'string' || requested.includes('\0') || path.isAbsolute(requested)) {
      throw new ProjectFilesError('Paths must be relative to the selected project.', 'INVALID_PATH');
    }
    const lexicalPath = path.resolve(root, requested || '.');
    if (!isWithin(root, lexicalPath)) {
      throw new ProjectFilesError('The requested path is outside the selected project.', 'PATH_OUTSIDE_PROJECT');
    }

    let canonicalPath;
    let stats;
    try {
      canonicalPath = await fsPromises.realpath(lexicalPath);
      stats = await fsPromises.stat(canonicalPath);
    } catch {
      throw new ProjectFilesError('The requested project path does not exist.', 'PATH_NOT_FOUND');
    }
    if (!isWithin(root, canonicalPath)) {
      throw new ProjectFilesError('The requested path resolves outside the selected project.', 'PATH_OUTSIDE_PROJECT');
    }
    const relativePath = portableRelative(root, canonicalPath);
    const directory = stats.isDirectory();
    if (isBlockedRelative(relativePath, { directory })) {
      throw new ProjectFilesError('The requested path is excluded from project context.', 'PATH_BLOCKED');
    }
    if (expectedType === 'file' && !stats.isFile()) {
      throw new ProjectFilesError('The requested project path is not a file.', 'NOT_A_FILE');
    }
    if (expectedType === 'directory' && !directory) {
      throw new ProjectFilesError('The requested project path is not a directory.', 'NOT_A_DIRECTORY');
    }
    return { canonicalPath, relativePath, stats };
  };

  const safeChild = async (parent, entry) => {
    const lexicalPath = path.join(parent, entry.name);
    try {
      const lexicalStats = await fsPromises.lstat(lexicalPath);
      if (lexicalStats.isSymbolicLink()) return undefined;
      const canonicalPath = await fsPromises.realpath(lexicalPath);
      if (!isWithin(root, canonicalPath)) return undefined;
      const stats = await fsPromises.stat(canonicalPath);
      const relativePath = portableRelative(root, canonicalPath);
      if (isBlockedRelative(relativePath, { directory: stats.isDirectory() })) return undefined;
      return { canonicalPath, relativePath, stats };
    } catch {
      return undefined;
    }
  };

  const list = async ({ path: requestedPath = '.', maxEntries } = {}) => {
    const directory = await resolveExisting(requestedPath, 'directory');
    const limit = clampInteger(maxEntries, MAX_LIST_ENTRIES, 1, MAX_LIST_ENTRIES);
    const entries = await fsPromises.readdir(directory.canonicalPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const result = [];
    let truncated = false;
    for (const entry of entries) {
      const child = await safeChild(directory.canonicalPath, entry);
      if (!child) continue;
      if (result.length >= limit) {
        truncated = true;
        break;
      }
      result.push({
        path: child.relativePath,
        type: child.stats.isDirectory() ? 'directory' : child.stats.isFile() ? 'file' : 'other',
        ...(child.stats.isFile() ? { size: child.stats.size } : {}),
      });
    }
    return { path: directory.relativePath, entries: result, truncated };
  };

  const read = async ({ path: requestedPath, startLine, endLine } = {}) => {
    if (!requestedPath) throw new ProjectFilesError('path is required.', 'INVALID_PATH');
    const file = await resolveExisting(requestedPath, 'file');
    if (file.stats.size > MAX_READ_FILE_BYTES) {
      throw new ProjectFilesError('The file is too large for project context.', 'FILE_TOO_LARGE');
    }
    const buffer = await fsPromises.readFile(file.canonicalPath);
    if (buffer.length > MAX_READ_FILE_BYTES) {
      throw new ProjectFilesError('The file is too large for project context.', 'FILE_TOO_LARGE');
    }
    const text = decodeText(buffer);
    const lines = text.split(/\r?\n/);
    const first = clampInteger(startLine, 1, 1, Math.max(1, lines.length));
    const requestedEnd = clampInteger(endLine, first + 499, first, Math.max(first, lines.length));
    const last = Math.min(requestedEnd, first + MAX_READ_LINES - 1);
    let content = lines.slice(first - 1, last).join('\n');
    let truncated = last < lines.length;
    if (content.length > MAX_READ_CHARS) {
      content = content.slice(0, MAX_READ_CHARS);
      truncated = true;
    }
    return {
      path: file.relativePath,
      startLine: first,
      endLine: Math.min(last, lines.length),
      totalLines: lines.length,
      truncated,
      content,
    };
  };

  const search = async ({ query, path: requestedPath = '.', maxResults } = {}) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) {
      throw new ProjectFilesError('query must contain 1 to 200 characters.', 'INVALID_QUERY');
    }
    const start = await resolveExisting(requestedPath);
    const resultLimit = clampInteger(maxResults, 50, 1, MAX_SEARCH_RESULTS);
    const needle = query.toLocaleLowerCase();
    const queue = start.stats.isDirectory() ? [start.canonicalPath] : [];
    const files = start.stats.isFile() ? [start] : [];
    const matches = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;

    while (queue.length > 0 && files.length < MAX_SEARCH_FILES) {
      const directoryPath = queue.shift();
      let entries;
      try {
        entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const child = await safeChild(directoryPath, entry);
        if (!child) continue;
        if (child.stats.isDirectory()) queue.push(child.canonicalPath);
        else if (child.stats.isFile() && child.stats.size <= MAX_SEARCH_FILE_BYTES) files.push(child);
        if (files.length >= MAX_SEARCH_FILES) {
          truncated = true;
          break;
        }
      }
    }
    if (queue.length > 0) truncated = true;

    for (const file of files) {
      if (matches.length >= resultLimit || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      let buffer;
      try {
        buffer = await fsPromises.readFile(file.canonicalPath);
        if (buffer.length > MAX_SEARCH_FILE_BYTES || buffer.includes(0)) continue;
        scannedBytes += buffer.length;
      } catch {
        continue;
      }
      scannedFiles += 1;
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLocaleLowerCase().includes(needle)) continue;
        matches.push({
          path: file.relativePath,
          line: index + 1,
          text: lines[index].trim().slice(0, 500),
        });
        if (matches.length >= resultLimit) {
          truncated = true;
          break;
        }
      }
    }

    return { query, matches, scannedFiles, truncated };
  };

  return { root, list, read, search };
}

export const PROJECT_FILE_TOOLS = [{
  name: 'list_project_files',
  description: 'List files and directories inside the user-selected project. Paths must be project-relative.',
  annotations: {
    title: 'List selected project files',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative directory path. Defaults to the project root.' },
      maxEntries: { type: 'integer', minimum: 1, maximum: MAX_LIST_ENTRIES },
    },
    additionalProperties: false,
  },
}, {
  name: 'read_project_file',
  description: 'Read a bounded range from a UTF-8 text file inside the user-selected project.',
  annotations: {
    title: 'Read selected project file',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative file path.' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
}, {
  name: 'search_project_text',
  description: 'Search for plain text inside bounded UTF-8 files in the user-selected project.',
  annotations: {
    title: 'Search selected project text',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 },
      path: { type: 'string', description: 'Optional project-relative file or directory path.' },
      maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
    },
    required: ['query'],
    additionalProperties: false,
  },
}];

export function startProjectFilesMcp(service, { input = process.stdin, output = process.stdout } = {}) {
  const lines = readline.createInterface({ input });
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);

  lines.on('line', async (line) => {
    if (!line || Buffer.byteLength(line) > 64 * 1024) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const { id, method, params } = message;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'thoughtdag-project-files', version: '0.2.6' },
        },
      });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: PROJECT_FILE_TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      try {
        const argumentsValue = params?.arguments && typeof params.arguments === 'object'
          ? params.arguments
          : {};
        let result;
        if (params?.name === 'list_project_files') result = await service.list(argumentsValue);
        else if (params?.name === 'read_project_file') result = await service.read(argumentsValue);
        else if (params?.name === 'search_project_text') result = await service.search(argumentsValue);
        else throw new ProjectFilesError('Unknown project file tool.', 'UNKNOWN_TOOL');
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        });
      } catch (error) {
        const safeError = error instanceof ProjectFilesError ? error : new ProjectFilesError('Project file request failed.');
        send({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `${safeError.code}: ${safeError.message}` }],
          },
        });
      }
      return;
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
  });
  return lines;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && comparablePath(process.argv[1]) === comparablePath(modulePath)) {
  createProjectFilesService(process.env.THOUGHTDAG_PROJECT_ROOT || '')
    .then((service) => startProjectFilesMcp(service))
    .catch(() => { process.exitCode = 1; });
}
