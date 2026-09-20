import { API_BASE } from './constants';
import { toast } from './ui-store';

export interface GenerationInteraction {
  id: string;
  token: string;
  method: string;
  params: {
    questions?: { id: string; question: string; options?: { label: string; description?: string }[] }[];
    permissions?: Record<string, unknown>;
    requestedPermissions?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

let queue: GenerationInteraction[] = [];
const listeners = new Set<() => void>();
const cleanups = new Map<string, () => void>();
function notify() { for (const listener of listeners) listener(); }
export const interactionSnapshot = () => queue;
export const subscribeInteractions = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function removeGenerationInteraction(id: string) {
  cleanups.get(id)?.(); cleanups.delete(id);
  queue = queue.filter(item => item.id !== id); notify();
}

export function requestGenerationInteraction(interaction: GenerationInteraction, signal?: AbortSignal): void {
  if (signal?.aborted || queue.some(item => item.id === interaction.id)) return;
  const abort = () => removeGenerationInteraction(interaction.id);
  signal?.addEventListener('abort', abort, { once: true });
  cleanups.set(interaction.id, () => signal?.removeEventListener('abort', abort));
  queue = [...queue, interaction]; notify();
}

export async function answerGenerationInteraction(interaction: GenerationInteraction, result: unknown): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/interactions/${encodeURIComponent(interaction.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ThoughtDAG-Interaction': interaction.token },
      body: JSON.stringify({ result }),
    });
    if (response.status === 404) removeGenerationInteraction(interaction.id);
    if (!response.ok) throw new Error('请求已结束或暂时无法提交 / Request ended or reply failed');
    removeGenerationInteraction(interaction.id);
  } catch (error) {
    toast('error', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
