# AGENTS.md

ThoughtDAG Codex：把 Codex 对话变成无限画布上可编辑的思维 DAG（节点=一轮问答，边=上下文流）。React 19 + Vite + TypeScript 前端，Express + `@openai/codex-sdk` 本地代理后端。基于 github.com/chenxiachan/thoughtdag 的 MIT 复刻。

## 常用命令

```bash
npm run dev      # Vite 前端 (默认 5173)
npm run server   # LLM 代理 server.mjs (端口 3001，前端默认指向它)
npm run build    # tsc -b && vite build
npm run smoke    # scripts/smoke.mjs 冒烟测试
npm run test:codex
npm run lint
```

真实生成需要先运行 `npm run codex:login`，也可在 `.env` 中设置 `CODEX_API_KEY`。Node.js 版本至少为 22.12。

## 架构

- `server.mjs` + `server/codex-adapter.mjs` — Express SSE 代理与 Codex SDK 适配层。前台按 DAG 路径映射持久线程并精确分支，后台使用独立 SDK 线程，动态读取 Codex 模型/思考档位；默认是受限只读 MCP，用户可显式切到项目内操作或完全访问，三档都由后端白名单映射到真实沙箱。
- `server/codex-model-catalog.mjs` — 通过 Codex App Server `model/list` 动态读取并校验模型及思考档位。
- `server/project-registry.mjs` + `server/project-files-mcp.mjs` — 桌面原生目录的运行期注册与受限只读文件访问；前端不得提交裸路径。
- `src/store/` — zustand 全局状态；持久化用 idb-keyval（IndexedDB）。
- `src/components/` — 画布基于 `@xyflow/react`（React Flow）：`ThoughtNode`、`ThoughtEdgeView`、`SelectionToolbar`（圈选对齐，对齐前有确认提示）、`focus-panel/`。
- `src/lib/api.ts` — 前端到 server.mjs 的调用层。
- `src/i18n/` — 中英双语。
- Markdown 渲染：react-markdown + KaTeX + highlight.js；PDF 附件用 pdfjs-dist。
- `functions/api/[[path]].js` — 静态/边缘部署的只读 API；边缘运行时不能启动 Codex，生成端点必须明确返回 local-only，禁止静默回落旧供应商。

## 约定

- 布局必须遵守箭头（上下文流）顺序，同一对话链节点竖向对齐——这是用户明确要求过的行为，改布局逻辑时不要破坏。
- 连线是唯一对话历史事实源。持久线程只在路径和父回合映射仍匹配时续接；结构分支精确 fork，多路输入或无映射图新建线程。
- 与用户交流用中文；代码标识符和注释保持英文。
- UI 文案（i18n、tooltip、toast、placeholder）不出现第三方品牌名。功能性标识除外：环境变量名、导入格式的身份（如 ChatGPT 导出文件）、实际数据源（arXiv、Semantic Scholar）。举例、推荐、宣传式的品牌提及一律用通称（"外部 OCR 工具""其他助手"）或扩展名（.docx）替代。
