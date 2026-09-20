import { useCallback, type RefObject } from 'react';
import { useProjects } from '../store/projects';
import { isViewerMode } from './viewer';

// Small UI-only values: persist synchronously so switching or closing a
// reader immediately cannot outrun a debounced graph/IndexedDB write.
const memory = new Map<string, number>();

export function useReadingPosition(
  nodeId: string | null,
  surface: string,
  existingRef?: RefObject<HTMLDivElement | null>,
  restore = true,
) {
  const projectId = useProjects(s => s.activeId);
  const key = JSON.stringify([projectId, nodeId, surface]);
  return useCallback((element: HTMLDivElement | null) => {
    if (existingRef) existingRef.current = element;
    if (!element || !nodeId) return;
    const storageKey = `thoughtdag:reading:${key}`;
    let saved = memory.get(key) ?? 0;
    if (!isViewerMode) {
      try {
        const raw = localStorage.getItem(storageKey);
        const value = Number(raw);
        if (raw !== null && Number.isFinite(value) && value >= 0) saved = value;
      } catch { /* Memory still works if storage is unavailable. */ }
    }
    let restoring = restore;
    const persist = () => {
      if (restoring) return;
      const value = element.scrollTop;
      memory.set(key, value);
      if (!isViewerMode) {
        try { localStorage.setItem(storageKey, String(value)); } catch { /* Keep the session value. */ }
      }
    };
    const attempt = () => {
      if (!restoring) return;
      element.scrollTop = saved;
      // Attachments, images and fonts can arrive after the first render.
      // Don't replace the saved offset with an initially clamped value.
      if (element.scrollHeight - element.clientHeight >= saved) restoring = false;
    };
    const interact = () => { restoring = false; };
    const observer = new ResizeObserver(attempt);
    observer.observe(element);
    const mutations = new MutationObserver(() => {
      for (const child of element.children) observer.observe(child);
      attempt();
    });
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    for (const child of element.children) observer.observe(child);
    attempt();
    element.addEventListener('scroll', persist, { passive: true });
    element.addEventListener('wheel', interact, { passive: true });
    element.addEventListener('pointerdown', interact);
    element.addEventListener('keydown', interact);
    return () => {
      // Scroll events already save the old node before React replaces its
      // content; reading DOM here could save the next node's clamped offset.
      observer.disconnect();
      mutations.disconnect();
      element.removeEventListener('scroll', persist);
      element.removeEventListener('wheel', interact);
      element.removeEventListener('pointerdown', interact);
      element.removeEventListener('keydown', interact);
      if (existingRef?.current === element) existingRef.current = null;
    };
  }, [key, nodeId, existingRef, restore]);
}
