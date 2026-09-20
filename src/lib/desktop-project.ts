import { useUiStore } from './ui-store';

let hydrationPromise: Promise<void> | null = null;

/**
 * Restore the desktop-selected Codex project exactly once before a request
 * snapshots generation preferences. Browser builds resolve immediately.
 */
export function ensureDesktopProjectHydrated(): Promise<void> {
  const getProjectFolder = window.desktop?.getProjectFolder;
  if (!getProjectFolder) {
    useUiStore.getState().setCodexProjectHydrated(true);
    return Promise.resolve();
  }
  if (useUiStore.getState().codexProjectHydrated) return Promise.resolve();
  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = getProjectFolder()
    .then((project) => {
      const state = useUiStore.getState();
      state.setCodexProjectFolder(project);
      state.setCodexProjectHydrated(true);
    })
    .catch((error) => {
      // Let the next request retry instead of silently falling back to the
      // isolated workspace while a saved desktop project may still exist.
      hydrationPromise = null;
      throw error;
    });
  return hydrationPromise;
}

export function commitDesktopProject(project: DesktopProjectFolder | null): void {
  const state = useUiStore.getState();
  state.setCodexProjectFolder(project);
  state.setCodexProjectHydrated(true);
  hydrationPromise = Promise.resolve();
}
