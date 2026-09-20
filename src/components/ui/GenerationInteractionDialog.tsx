import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { answerGenerationInteraction, interactionSnapshot, subscribeInteractions, type GenerationInteraction } from '../../lib/generation-interactions';

function Request({ item }: { item: GenerationInteraction }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [form, setForm] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const questionMode = item.method === 'item/tool/requestUserInput';
  const mcpMode = item.method === 'mcpServer/elicitation/request';
  const permissionMode = item.method === 'item/permissions/requestApproval';
  async function submit(accepted: boolean) {
    try {
      setError('');
      let result: unknown;
      if (questionMode) result = { answers: Object.fromEntries((item.params.questions || []).map(q => [q.id, { answers: accepted && answers[q.id]?.trim() ? [answers[q.id].trim()] : [] }])) };
      else if (mcpMode) result = { action: accepted ? 'accept' : 'decline', content: accepted ? JSON.parse(form) : null };
      else if (permissionMode) result = { permissions: accepted ? item.params.permissions || item.params.requestedPermissions || {} : {}, scope: 'turn' };
      else result = { decision: accepted ? 'accept' : 'decline' };
      setBusy(true);
      await answerGenerationInteraction(item, result);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-[1000] bg-black/70 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="生成需要你的输入">
    <div className="bg-card text-ink border border-line rounded-xl p-5 max-w-2xl w-full max-h-[85vh] overflow-y-auto">
      <h2 className="font-semibold mb-4">{questionMode ? '需要你的回答 / Your input is needed' : '操作需要确认 / Approval required'}</h2>
      {questionMode ? (item.params.questions || []).map(q => <div key={q.id} className="mb-4">
        <p className="text-sm mb-2">{q.question}</p>
        {q.options?.map(option => <button key={option.label} onClick={() => setAnswers({ ...answers, [q.id]: option.label })} className="block text-left text-sm border border-line rounded p-2 mb-1 w-full hover:bg-wash" title={option.description}>{option.label}{option.description && <span className="block text-xs text-ink-muted">{option.description}</span>}</button>)}
        <textarea aria-label={q.question} value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} className="w-full bg-wash border border-line rounded p-2 text-sm" />
      </div>) : <pre className="whitespace-pre-wrap break-words text-xs bg-wash rounded p-3 mb-3">{JSON.stringify(item.params, null, 2)}</pre>}
      {mcpMode && <label className="text-sm block">填写请求所需的 JSON / Requested JSON<input value={form} onChange={e => setForm(e.target.value)} className="block w-full bg-wash border border-line p-2 my-2" /></label>}
      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button disabled={busy} onClick={() => void submit(false)} className="px-3 py-2 rounded bg-wash">{questionMode ? '跳过 / Skip' : '拒绝 / Decline'}</button>
        <button disabled={busy} onClick={() => void submit(true)} className="px-3 py-2 rounded bg-accent text-white">{questionMode ? '提交 / Submit' : '允许本次 / Allow once'}</button>
      </div>
    </div>
  </div>;
}

export default function GenerationInteractionDialog() {
  const queue = useSyncExternalStore(subscribeInteractions, interactionSnapshot);
  return queue[0] ? createPortal(<Request key={queue[0].id} item={queue[0]} />, document.body) : null;
}
