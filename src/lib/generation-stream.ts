import type { CodexStreamMetadata } from './api';
import type { GenerationInteraction } from './generation-interactions';

export interface GenerationStreamCallbacks {
  onText: (chunk: string, full: string) => void;
  onReasoning?: (chunk: string, full: string) => void;
  onCommentary?: (text: string) => void;
  onMetadata?: (metadata: CodexStreamMetadata) => void;
  onTool?: (name: string, query: string) => void;
  onInteractionsClosed?: (ids: string[]) => void;
  onInteraction?: (interaction: GenerationInteraction) => void;
}

export async function consumeGenerationStream(response: Response, callbacks: GenerationStreamCallbacks): Promise<string> {
  if (!response.body) throw new Error('生成流为空 / Missing response stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const interactions = new Set<string>();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let done = false;
  let status: string | undefined;
  let finalSnapshot = false;

  const line = (raw: string) => {
    if (done || !raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const frame = JSON.parse(data);
    if (frame.metadata) { status = frame.metadata.status ?? status; callbacks.onMetadata?.(frame.metadata); }
    if (frame.error) throw new Error(typeof frame.error === 'string' ? frame.error : '生成失败 / Generation failed');
    if (typeof frame.text === 'string') { text += frame.text; callbacks.onText(frame.text, text); }
    if (typeof frame.reasoning === 'string') { reasoning += frame.reasoning; callbacks.onReasoning?.(frame.reasoning, reasoning); }
    if (frame.snapshot) {
      if (typeof frame.snapshot.text === 'string') { text = frame.snapshot.text; callbacks.onText('', text); finalSnapshot = true; }
      if (typeof frame.snapshot.reasoning === 'string') { reasoning = frame.snapshot.reasoning; callbacks.onReasoning?.('', reasoning); }
      if (typeof frame.snapshot.commentary === 'string') callbacks.onCommentary?.(frame.snapshot.commentary);
    }
    if (frame.status || frame.threadId || frame.model || frame.usage) {
      status = frame.status ?? status;
      callbacks.onMetadata?.({
        status, model: frame.model, reasoningEffort: frame.reasoningEffort,
        modelSpeed: frame.modelSpeed, serviceTier: frame.serviceTier,
        threadId: frame.threadId, turnId: frame.turnId, threadMode: frame.threadMode,
        ...(frame.usage ? { usage: frame.usage } : {}),
        ...(typeof frame.contextCompacted === 'boolean' ? { contextCompacted: frame.contextCompacted } : {}),
      });
    }
    if (frame.tool?.name) callbacks.onTool?.(frame.tool.name, frame.tool.query || '');
    if (frame.interaction) { interactions.add(frame.interaction.id); callbacks.onInteraction?.(frame.interaction); }
  };

  try {
    while (!done) {
      const part = await reader.read();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const value of lines) line(value.replace(/\r$/, ''));
      if (part.done) { if (buffer.trim()) line(buffer.replace(/\r$/, '')); break; }
    }
    if (!done || status !== 'completed' || !finalSnapshot) {
      throw new Error('回答未完成：未收到完整结束确认，已保留收到的内容。 / Incomplete generation; received content retained.');
    }
    return text;
  } finally {
    callbacks.onInteractionsClosed?.([...interactions]);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
