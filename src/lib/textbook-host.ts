import { useStore } from '../store';
import { useProjects } from '../store/projects';
import { buildContentNode } from './content';
import { useUiStore } from './ui-store';
import { createAnchor, createCitation, resolveAnchor } from './textbook';
import type { ReaderCommand, ReaderReply, ReaderSnapshot } from './textbook';
import { flushPendingWrites } from './persistence';

export function readerSnapshot(): ReaderSnapshot {
  const { nodes } = useStore.getState();
  const snapshot: ReaderSnapshot = { projectId: useProjects.getState().activeId ?? '',
    documents: nodes.filter(n => n.data.textbook).map(n => ({ nodeId: n.id, document: n.data.textbook! })),
    questions: nodes.filter(n => n.data.sourceCitation).map(n => ({ id: n.id, question: n.data.question,
      citation: n.data.sourceCitation!, relocation: n.data.sourceRelocation, failed: n.data.generationFailed, ...n.data.sourceMark })) };
  // Include hidden entries when assigning legacy numbers: deletion never renumbers marks.
  for (const entry of snapshot.documents) {
    entry.document = { ...entry.document, marks: entry.document.marks.map(m => ({ ...m })) };
    const marks = [...entry.document.marks, ...snapshot.questions.filter(q => q.citation.materialId === entry.nodeId)];
    const used = new Set(marks.flatMap(m => m.number ? [m.number] : []));
    let next = 1;
    for (const mark of marks) {
      if (mark.number) continue;
      while (used.has(next)) next++;
      mark.number = next; used.add(next++);
    }
  }
  return snapshot;
}
export function locateTextbookQuestion(id: string) {
  useStore.getState().setSelectedNodeId(id);
  useUiStore.getState().setPanelOpen(true);
  window.dispatchEvent(new CustomEvent('textbook-locate', { detail: id }));
}
export function revealTextbook(materialId: string, nodeId?: string) {
  void window.desktop?.textbookReveal?.({ materialId, nodeId });
}
export async function handleReaderCommand(command: ReaderCommand): Promise<ReaderReply> {
  if (command.action === 'snapshot') return { snapshot: readerSnapshot() };
  const projectId = useProjects.getState().activeId ?? '';
  if (command.projectId !== projectId) throw new Error('主窗口已切换画布，请在更新后的文章列表中重试。');
  const store = useStore.getState();
  if (command.action === 'open') {
    const { libraryId, relativePath } = command;
    if (!libraryId || !relativePath) throw new Error('缺少文章文件。');
    const file = await window.desktop!.textbookFiles!({ action: 'read', libraryId, relativePath }) as { content: string; version: string };
    if ((useProjects.getState().activeId ?? '') !== projectId) throw new Error('画布已切换，请重试。');
    const latest = useStore.getState();
    const existing = latest.nodes.find(n => n.data.textbook?.libraryId === libraryId && n.data.textbook?.relativePath === relativePath);
    const node = existing ?? buildContentNode('note', { x: 0, y: latest.nodes.length * 90 }, { question: relativePath });
    const doc = { ...node.data.textbook, id: node.data.textbook?.id ?? crypto.randomUUID(), libraryId, relativePath,
      title: file.content.match(/^#\s+(.+)$/m)?.[1] ?? relativePath, ...file, marks: node.data.textbook?.marks ?? [], lastReadAt: Date.now() };
    const updated = { ...node, data: { ...node.data, question: doc.title, textbook: doc } };
    useStore.setState({ nodes: existing ? latest.nodes.map(n => n.id === node.id ? updated : n) : [...latest.nodes, updated] });
    if (!existing) useStore.getState().pushHistory();
    await flushPendingWrites();
    return { materialId: node.id, snapshot: readerSnapshot() };
  }
  if (command.action === 'locate') { if (store.nodes.some(n => n.id === command.nodeId)) locateTextbookQuestion(command.nodeId!); return {}; }
  const material = store.nodes.find(n => n.id === command.materialId);
  const doc = material?.data.textbook;
  if (!material || !doc) throw new Error('资料节点已不存在。');
  if (command.action === 'position') {
    if (Number.isFinite(command.scrollTop)) useStore.setState({ nodes: store.nodes.map(n => n.id === material.id ? { ...n, data: { ...n.data, textbook: { ...doc, scrollTop: Math.max(0, command.scrollTop!), lastReadAt: Date.now() } } } : n) });
    return {};
  }
  if (command.action === 'delete-mark' || command.action === 'resend') {
    const target = store.nodes.find(n => n.id === command.nodeId && n.data.sourceCitation?.materialId === material.id);
    const readingMark = doc.marks.find(m => m.id === command.nodeId);
    if (!target && !readingMark) throw new Error('此标记已不存在。');
    if (command.action === 'delete-mark') {
      useStore.setState({ nodes: store.nodes.map(n => n.id === target?.id
        ? { ...n, data: { ...n.data, sourceMark: { ...n.data.sourceMark, hidden: true } } }
        : n.id === material.id ? { ...n, data: { ...n.data, textbook: { ...doc, marks: doc.marks.map(m => m.id === command.nodeId ? { ...m, hidden: true } : m) } } } : n) });
      store.pushHistory();
    } else {
      if (!target || target.data.sourceMark?.hidden) throw new Error('此问题标记已删除。');
      if (target.data.isLoading) throw new Error('这个问题正在回答，请先在主窗口停止生成。');
      const question = command.question?.trim();
      if (!question) throw new Error('请输入问题。');
      // Existing edit/version generation retains the node, citation and earlier answers.
      void store.editQuestion(target.id, question);
      locateTextbookQuestion(target.id);
    }
    await flushPendingWrites();
    return { snapshot: readerSnapshot() };
  }
  const submitted = command.anchor;
  if (!submitted || submitted.documentId !== doc.id) throw new Error('选区与文档不匹配。');
  const position = resolveAnchor(submitted, doc.content, doc.version);
  if (!position) throw new Error('原文已变化，请重新框选。');
  const anchor = createAnchor(doc, position.start, position.end);
  if (command.action === 'ask') {
    const question = command.question?.trim();
    if (!question) throw new Error('请输入问题。');
    if (!['nearby', 'section', 'chapter'].includes(command.scope ?? '')) throw new Error('请选择引用范围。');
    // No parentId: the currently selected question can never leak into a new passage.
    const sourceCitation = createCitation(material.id, anchor, command.scope!);
    store.addQuestion(question, { sourceCitation, mentions: command.mentions });
    const created = useStore.getState().nodes.find(n => n.data.sourceCitation === sourceCitation);
    if (!created) throw new Error('当前画布暂时无法创建问题，请稍后重试。');
    const before = readerSnapshot();
    const number = Math.max(0, ...before.questions.filter(q => q.citation.materialId === material.id && q.id !== created.id).map(q => q.number ?? 0), ...(before.documents.find(d => d.nodeId === material.id)?.document.marks ?? []).map(m => m.number ?? 0)) + 1;
    useStore.setState({ nodes: useStore.getState().nodes.map(n => n.id === created.id ? { ...n, data: { ...n.data, sourceMark: { number } } } : n) });
    locateTextbookQuestion(created.id);
  } else if (command.action === 'highlight') {
    useStore.setState({ nodes: store.nodes.map(n => n.id === material.id ? { ...n, data: { ...n.data, textbook: { ...doc, marks: [...doc.marks, { id: crypto.randomUUID(), anchor }] } } } : n) });
    useStore.getState().pushHistory();
  } else if (command.action === 'reanchor') {
    // Preserve the citation and snapshot sent at ask time; navigation may change.
    useStore.setState({ nodes: store.nodes.map(n => n.id === command.nodeId && n.data.sourceCitation?.materialId === material.id ? { ...n, data: { ...n.data, sourceRelocation: anchor } } : n) });
    useStore.getState().pushHistory();
  }
  await flushPendingWrites();
  return { snapshot: readerSnapshot() };
}

export function bootTextbookHost() {
  const desktop = window.desktop;
  if (!desktop?.onTextbookEvent) return;
  const jobs = new Map<string, Promise<ReaderReply>>();
  desktop.onTextbookEvent('command', value => {
    const command = value as ReaderCommand;
    let job = jobs.get(command.id);
    if (!job) {
      job = handleReaderCommand(command).catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
      jobs.set(command.id, job);
      if (jobs.size > 1000) jobs.delete(jobs.keys().next().value!);
    }
    void job.then(reply => desktop.textbookReply?.(command.id, reply));
  });
  let timer: ReturnType<typeof setTimeout>;
  let previous: ReaderSnapshot | undefined;
  const publish = () => {
    const next = readerSnapshot();
    // Response tokens and canvas drags do not change the reader's data. Avoid
    // repeatedly serializing every chapter during model streaming or scrolling.
    if (previous?.projectId === next.projectId && previous.documents.length === next.documents.length && previous.questions.length === next.questions.length
      && next.documents.every((d, i) => { const p = previous!.documents[i]; return d.nodeId === p.nodeId && d.document.content === p.document.content && d.document.version === p.document.version && d.document.libraryId === p.document.libraryId && JSON.stringify(d.document.marks) === JSON.stringify(p.document.marks); })
      && next.questions.every((q, i) => { const p = previous!.questions[i]; return q.id === p.id && q.question === p.question && q.citation === p.citation && q.relocation === p.relocation && q.failed === p.failed && q.number === p.number && q.hidden === p.hidden; })) return;
    previous = next;
    clearTimeout(timer); timer = setTimeout(() => desktop.textbookPublish?.(readerSnapshot()), 100);
  };
  useStore.subscribe(publish);
  useProjects.subscribe(publish);
  publish();
}
