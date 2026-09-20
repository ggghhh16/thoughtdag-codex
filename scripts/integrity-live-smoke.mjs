import fs from 'node:fs';
import { createCodexAdapter } from '../server/codex-adapter.mjs';
import { createCodexAppServerClient } from '../server/codex-app-server-client.mjs';

const clients = [];
const options = [];
const adapter = createCodexAdapter({ appServerFactory(config) { options.push(config); const client = createCodexAppServerClient(config); clients.push(client); return client; } });
const events = [];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 180000);
try {
  const result = await adapter.runStream({
    messages: [{role:'user',content:'This is a transport integration test. Do not use any tools. Reply with exactly THOUGHTDAG_INTEGRITY_OK.'}],
    codexLink: {mode:'start'}, permissionMode:'full', mcpTools:true,
    signal:controller.signal, onEvent:event => events.push(event),
  });
  const snapshot = events.filter(event=>event.type==='snapshot').at(-1)?.snapshot;
  const report = {
    status:result.status, model:result.model, effort:result.reasoningEffort,
    exactOutput:result.text.trim()==='THOUGHTDAG_INTEGRITY_OK',
    finalSnapshotMatches:snapshot?.text===result.text,
    reasoningChars:result.reasoning?.length || 0,
    usage:result.usage,
    runtimeFeatureOverrides:options[0]?.configOverrides?.filter(value=>value.startsWith('features.')),
  };
  fs.writeFileSync(new URL('../live-smoke-result.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if (result.threadId) await clients[0].request('thread/archive',{threadId:result.threadId});
  if (!report.exactOutput || !report.finalSnapshotMatches || result.status!=='completed') process.exitCode=1;
} finally {clearTimeout(timer);adapter.close();}
