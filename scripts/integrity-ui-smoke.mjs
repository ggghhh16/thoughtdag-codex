import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ server: { host:'127.0.0.1', port:0 }, plugins:[{
  name:'integrity-qa', configureServer(vite) {
    vite.middlewares.use('/__integrity-qa', async (_req,res) => {
      const html = `<html data-theme="dark"><head><meta charset="utf-8"><style>body{margin:0;background:#101318;color:#eee;color-scheme:dark}</style></head><body><div id="root"></div><script type="module">
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import Dialog from '/src/components/ui/GenerationInteractionDialog.tsx';
        import {requestGenerationInteraction} from '/src/lib/generation-interactions.ts';
        import '/src/index.css';
        createRoot(document.getElementById('root')).render(React.createElement(Dialog));
        window.ask = requestGenerationInteraction;
        requestGenerationInteraction({id:'test-question',token:'test-only',method:'item/tool/requestUserInput',params:{questions:[{id:'format',question:'报告包含哪些内容？',options:[{label:'完整报告',description:'保留分析、证据和结论'},{label:'简短结论'}]}]}});
      </script></body></html>`;
      res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__integrity-qa',html));
    });
  },
}] });
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1200,height:800}});
  page.setDefaultTimeout(10000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const responses=[];
  await page.route('**/api/interactions/**',async route=>{responses.push(route.request().postDataJSON());await route.fulfill({json:{ok:true}});});
  await page.goto(`http://127.0.0.1:${port}/__integrity-qa`);
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:/完整报告/}).click();
  await page.screenshot({path:'interaction-question.png'});
  await page.getByRole('button',{name:'提交 / Submit'}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.deepEqual(responses[0].result,{answers:{format:{answers:['完整报告']}}});
  await page.evaluate(()=>window.ask({id:'test-approval',token:'test-only',method:'item/commandExecution/requestApproval',params:{command:'read project report',reason:'读取用户指定的项目报告'}}));
  await page.getByRole('dialog').waitFor();
  await page.screenshot({path:'interaction-approval.png'});
  await page.getByRole('button',{name:'拒绝 / Decline'}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.deepEqual(responses[1].result,{decision:'decline'});
  assert.deepEqual(errors,[]);
  fs.writeFileSync('ui-smoke-result.json',JSON.stringify({questionSubmitted:true,approvalDeclined:true,errors},null,2));
  console.log('UI_SMOKE_OK');
} finally {await browser?.close();await server.close();}
