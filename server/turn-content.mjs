/** Reconcile streamed deltas with authoritative completed items. */
export class TurnContent {
  constructor() { this.items = new Map(); this.compacted = false; }

  item(id, type) {
    if (!this.items.has(id)) this.items.set(id, { id, type, text: '', summary: [], content: [] });
    return this.items.get(id);
  }

  apply(method, params = {}) {
    const id = params.itemId || params.item?.id || 'legacy';
    if (method === 'item/agentMessage/delta') {
      this.item(id, 'agentMessage').text += params.delta || '';
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const row = this.item(id, 'reasoning');
      const key = method.includes('summary') ? 'summary' : 'content';
      const index = params.summaryIndex ?? params.contentIndex ?? 0;
      row[key][index] = (row[key][index] || '') + (params.delta || '');
    } else if (method === 'item/reasoning/summaryPartAdded') {
      const row = this.item(id, 'reasoning');
      row.summary[params.summaryIndex ?? row.summary.length] ??= '';
    } else if (method === 'item/started' || method === 'item/completed') {
      const value = params.item;
      if (value?.type === 'contextCompaction') this.compacted = true;
      if (!value || !['agentMessage', 'reasoning'].includes(value.type)) return;
      const row = this.item(id, value.type);
      if (typeof value.phase === 'string') row.phase = value.phase;
      if (method === 'item/completed') {
        if (typeof value.text === 'string') row.text = value.text;
        for (const key of ['summary', 'content']) {
          if (Array.isArray(value[key])) row[key] = value[key].map(part => typeof part === 'string' ? part : part?.text || '');
        }
      }
    } else if (method === 'turn/completed') {
      for (const item of params.turn?.items || []) this.apply('item/completed', { item });
    }
  }

  snapshot() {
    const rows = [...this.items.values()];
    const messages = rows.filter(row => row.type === 'agentMessage');
    const final = messages.filter(row => row.phase === 'final_answer');
    const answers = final.length ? final : messages.filter(row => row.phase !== 'commentary');
    return {
      text: answers.map(row => row.text).filter(Boolean).join('\n\n'),
      commentary: messages.filter(row => row.phase === 'commentary').map(row => row.text).filter(Boolean).join('\n\n'),
      reasoning: rows.filter(row => row.type === 'reasoning').map(row => {
        const summaries = row.summary.filter(Boolean);
        return (summaries.length ? summaries : row.content.filter(Boolean)).join('\n\n');
      }).filter(Boolean).join('\n\n'),
      contextCompacted: this.compacted,
    };
  }
}
