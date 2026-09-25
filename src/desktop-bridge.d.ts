// The desktop shell's preload bridge (desktop/preload.js). Absent on the
// web app — presence of window.desktop IS the "running in the shell" test.
// Methods beyond checkForUpdates are optional: an older shell may pair with
// a newer page during dev; the page degrades to the shell's own dialogs.
interface DesktopUpdateEvent {
  kind: 'available' | 'downloading' | 'ready' | 'latest' | 'check-failed' | 'download-failed' | 'dev';
  version?: string;
  percent?: number;
}

interface DesktopProjectFolder {
  /** Opaque server registration id; renderer never sends a filesystem path. */
  id: string;
  name: string;
  path: string;
}

interface DesktopProjectSelection {
  canceled: boolean;
  project: DesktopProjectFolder | null;
}

interface DesktopCodexThreadListOptions {
  search?: string;
  cursor?: string;
  limit?: number;
  archived?: boolean;
}

type DesktopLegacyStorageEntry = [key: string, value: unknown];

interface DesktopBridge {
  textbookOpen?: () => Promise<void>;
  textbookDock?: (value: boolean) => Promise<boolean>;
  textbookFiles?: (request: { action: string; lang?: 'en' | 'zh'; libraryId?: string; relativePath?: string; replaceId?: string; version?: string; content?: string }) => Promise<unknown>;
  textbookCommand?: (command: import('./lib/textbook').ReaderCommand) => Promise<import('./lib/textbook').ReaderReply>;
  textbookReply?: (id: string, reply: import('./lib/textbook').ReaderReply) => void;
  textbookPublish?: (snapshot: import('./lib/textbook').ReaderSnapshot) => void;
  textbookReveal?: (request: { materialId: string; nodeId?: string }) => Promise<void>;
  onTextbookEvent?: (channel: 'command' | 'snapshot' | 'reveal', cb: (value: unknown) => void) => () => void;
  checkForUpdates: () => Promise<void>;
  downloadUpdate?: () => Promise<void>;
  installUpdate?: () => Promise<void>;
  onUpdateEvent?: (cb: (e: DesktopUpdateEvent) => void) => (() => void);
  getProjectFolder?: () => Promise<DesktopProjectFolder | null>;
  selectProjectFolder?: (options?: { activate?: boolean }) => Promise<DesktopProjectSelection>;
  activateProjectFolder?: (path: string) => Promise<DesktopProjectFolder>;
  openProjectFolder?: (path: string) => Promise<void>;
  createProjectWorktree?: (path: string) => Promise<DesktopProjectSelection>;
  clearProjectFolder?: () => Promise<null>;
  /** Read-only access to local Codex history; the main process adds the
   *  desktop control token so it is never exposed to renderer JavaScript. */
  listCodexThreads?: (options?: DesktopCodexThreadListOptions) => Promise<unknown>;
  readCodexThread?: (threadId: string) => Promise<unknown>;
  /** One-shot, allowlisted snapshot from the former 127.0.0.1:31174 origin. */
  readLegacyStorage31174?: () => Promise<DesktopLegacyStorageEntry[]>;
}

interface Window {
  desktop?: DesktopBridge;
}
