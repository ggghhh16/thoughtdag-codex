import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { TurnContent } from '../server/turn-content.mjs';
import { CodexAppServerClient } from '../server/codex-app-server-client.mjs';
import { createCodexAdapter } from '../server/codex-adapter.mjs';
import { consumeGenerationStream } from '../src/lib/generation-stream.ts';

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
async function parse(wire) {
  let text = '', reasoning = '', commentary = '';
  const metadata = [];
  const promise = consumeGenerationStream(new Response(wire), {
    onText: (_, value) => { text = value; }, onReasoning: (_, value) => { reasoning = value; },
    onCommentary: value => { commentary = value; }, onMetadata: value => metadata.push(value),
  });
  return { promise, values: () => ({text, reasoning, commentary, metadata}) };
}

test('completed items replace missing tails, revisions and reasoning sections', () => {
  const content = new TurnContent();
  content.apply('item/agentMessage/delta', { itemId: 'a', delta: 'old incomplete' });
  content.apply('item/completed', { item: { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'revised complete answer' } });
  content.apply('item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'first', summaryIndex: 0 });
  content.apply('item/completed', { item: { id: 'r', type: 'reasoning', summary: ['first', 'second'], content: ['alternative raw content'] } });
  assert.equal(content.snapshot().text, 'revised complete answer');
  assert.equal(content.snapshot().reasoning, 'first\n\nsecond');
});

test('commentary, final answer and fallback reasoning stay distinct', () => {
  const content = new TurnContent();
  for (const item of [
    { id: 'c', type: 'agentMessage', phase: 'commentary', text: 'Working' },
    { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'Answer' },
    { id: 'r', type: 'reasoning', summary: [], content: ['Available text'] },
    { id: 'compact', type: 'contextCompaction' },
  ]) content.apply('item/completed', { item });
  assert.deepEqual(content.snapshot(), { text: 'Answer', commentary: 'Working', reasoning: 'Available text', contextCompacted: true });
});

test('frontend replaces partial content with final snapshot and preserves long Unicode strings', async () => {
  const text = '中文🙂'.repeat(35000) + 'END';
  const run = await parse(frame({ text: 'partial' }) + frame({ snapshot: {text, reasoning: text, commentary:'progress'} }) + frame({status:'completed'}) + 'data: [DONE]\n\n');
  assert.equal(await run.promise, text);
  assert.equal(run.values().reasoning, text);
  assert.equal(run.values().commentary, 'progress');
});

test('EOF without DONE retains partial text but fails', async () => {
  const run = await parse(frame({text:'partial'}));
  await assert.rejects(run.promise, /Incomplete/);
  assert.equal(run.values().text, 'partial');
});

test('DONE without completed status and authoritative snapshot fails', async () => {
  for (const wire of [frame({text:'partial'})+'data: [DONE]\n\n', frame({snapshot:{text:'partial'}})+frame({status:'interrupted'})+'data: [DONE]\n\n']) {
    const run = await parse(wire); await assert.rejects(run.promise, /Incomplete/);
  }
});

test('unterminated last data line is processed without treating EOF as success', async () => {
  const run = await parse(frame({text:'head'})+'data: {"text":"tail"}');
  await assert.rejects(run.promise, /Incomplete/);
  assert.equal(run.values().text, 'headtail');
});

test('unterminated DONE line is accepted only with complete metadata and snapshot', async () => {
  const run = await parse(frame({snapshot:{text:'complete'}})+frame({status:'completed'})+'data: [DONE]');
  assert.equal(await run.promise, 'complete');
});

test('split UTF-8 bytes and CRLF frames do not corrupt text', async () => {
  const wire = new TextEncoder().encode((frame({snapshot:{text:'中文🙂结尾'}})+frame({status:'completed'})+'data: [DONE]\n\n').replaceAll('\n','\r\n'));
  const stream = new ReadableStream({ start(controller) { for (const byte of wire) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const run = await parse(stream); assert.equal(await run.promise, '中文🙂结尾');
});

test('explicit errors remain errors even if DONE follows', async () => {
  const run = await parse(frame({text:'partial'})+frame({error:'real failure'})+'data: [DONE]\n\n');
  await assert.rejects(run.promise, /real failure/);
});

test('App Server client accepts completed-only message and separates phases', async () => {
  const fake = new EventEmitter();
  fake.onNotification = fn => { fake.on('notification',fn); return () => fake.off('notification',fn); };
  fake.request = async () => {
    queueMicrotask(() => {
      for (const item of [{id:'c',type:'agentMessage',phase:'commentary',text:'working'}, {id:'a',type:'agentMessage',phase:'final_answer',text:'complete'}]) fake.emit('notification',{method:'item/completed',params:{threadId:'t',turnId:'u',item}});
      fake.emit('notification',{method:'turn/completed',params:{threadId:'t',turn:{id:'u',status:'completed',items:[]}}});
    });
    return {turn:{id:'u'}};
  };
  const result = await CodexAppServerClient.prototype.startTurn.call(fake, {threadId:'t'});
  assert.equal(result.text,'complete'); assert.equal(result.commentary,'working');
});

test('adapter rejects interrupted turns and emits their status', async () => {
  const events=[];
  const adapter=createCodexAdapter({authProbe:async()=>true, modelCatalog:{getCatalog:async()=>({source:'app-server',defaultModelId:'audit',models:[{id:'audit',supportedReasoningEfforts:[],defaultReasoningEffort:null}]})}, appServerFactory:()=>({
    startThread:async()=>({thread:{id:'t'}}),request:async()=>({}),close(){},
    startTurn:async(_params,cbs)=>{cbs.onAgentMessageDelta('partial');return {turnId:'u',turn:{status:'interrupted'},text:'partial'};},
  })});
  try { await assert.rejects(adapter.runStream({messages:[{role:'user',content:'test'}],codexLink:{mode:'start'},onEvent:e=>events.push(e)})); }
  finally {adapter.close();}
  assert.equal(events.find(e=>e.type==='metadata').metadata.status,'interrupted');
});
