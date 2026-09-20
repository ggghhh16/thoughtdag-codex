import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const DESKTOP_CONTROL_HEADER = 'x-thoughtdag-desktop-token';

const MAX_REGISTERED_PROJECTS = 256;

export class ProjectRegistryError extends Error {
  constructor(message, { code = 'PROJECT_REGISTRY_ERROR', statusCode = 400, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProjectRegistryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function secretMatches(expected, received) {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function createProjectRegistry({
  env = process.env,
  fsPromises = fs.promises,
  randomBytesImpl = randomBytes,
} = {}) {
  const controlToken = String(env.THOUGHTDAG_DESKTOP_CONTROL_TOKEN || '');
  const projects = new Map();

  const authenticate = (headerValue) => {
    if (!controlToken) {
      throw new ProjectRegistryError('Desktop project control is not configured.', {
        code: 'DESKTOP_CONTROL_DISABLED',
        statusCode: 503,
      });
    }
    const received = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof received !== 'string' || !secretMatches(controlToken, received)) {
      throw new ProjectRegistryError('Desktop project control authentication failed.', {
        code: 'DESKTOP_CONTROL_UNAUTHORIZED',
        statusCode: 401,
      });
    }
  };

  const register = async (requestedPath) => {
    if (typeof requestedPath !== 'string'
      || !requestedPath.trim()
      || requestedPath.length > 32_768
      || !path.isAbsolute(requestedPath)) {
      throw new ProjectRegistryError('path must be an absolute directory path.', {
        code: 'INVALID_PROJECT_PATH',
      });
    }
    if (projects.size >= MAX_REGISTERED_PROJECTS) {
      throw new ProjectRegistryError('Too many project directories are registered.', {
        code: 'PROJECT_REGISTRY_FULL',
        statusCode: 429,
      });
    }

    let canonicalPath;
    let stats;
    try {
      canonicalPath = await fsPromises.realpath(requestedPath);
      stats = await fsPromises.stat(canonicalPath);
    } catch (error) {
      throw new ProjectRegistryError('The selected project directory is unavailable.', {
        code: 'INVALID_PROJECT_PATH',
        cause: error,
      });
    }
    if (!stats.isDirectory()) {
      throw new ProjectRegistryError('The selected project path is not a directory.', {
        code: 'INVALID_PROJECT_PATH',
      });
    }

    let id;
    for (let attempt = 0; attempt < 10 && !id; attempt += 1) {
      const candidate = randomBytesImpl(24).toString('base64url');
      if (candidate && !projects.has(candidate)) id = candidate;
    }
    if (!id) {
      throw new ProjectRegistryError('Could not allocate a project id.', {
        code: 'PROJECT_ID_ALLOCATION_FAILED',
        statusCode: 500,
      });
    }
    const project = {
      id,
      name: path.basename(canonicalPath) || canonicalPath,
      path: canonicalPath,
    };
    projects.set(id, project);
    return { ...project };
  };

  const resolve = async (projectId) => {
    if (projectId === undefined || projectId === null || projectId === '') return undefined;
    if (typeof projectId !== 'string' || !projectId.trim()) {
      throw new ProjectRegistryError('projectId must be a non-empty string.', {
        code: 'INVALID_PROJECT_ID',
      });
    }
    const project = projects.get(projectId);
    if (!project) {
      throw new ProjectRegistryError('The selected project is not registered in this server session.', {
        code: 'INVALID_PROJECT_ID',
      });
    }

    try {
      const [canonicalPath, stats] = await Promise.all([
        fsPromises.realpath(project.path),
        fsPromises.stat(project.path),
      ]);
      if (!stats.isDirectory() || comparablePath(canonicalPath) !== comparablePath(project.path)) {
        throw new Error('Project directory identity changed');
      }
    } catch (error) {
      projects.delete(projectId);
      throw new ProjectRegistryError('The registered project directory is no longer available.', {
        code: 'INVALID_PROJECT_ID',
        cause: error,
      });
    }
    return project.path;
  };

  const unregister = (projectId) => {
    if (typeof projectId !== 'string' || !projects.delete(projectId)) {
      throw new ProjectRegistryError('The selected project is not registered in this server session.', {
        code: 'INVALID_PROJECT_ID',
        statusCode: 404,
      });
    }
  };

  return {
    authenticate,
    register,
    resolve,
    unregister,
    get size() { return projects.size; },
  };
}
