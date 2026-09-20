# Codex 配置与架构

[English](./setup.md) · [返回 README](../README_ZH.md)

## 环境要求

- Node.js 22.12 或更高版本
- npm
- 可用的 Codex 登录态，或 `CODEX_API_KEY`

Codex App Server 与 Codex SDK 在本地 Node 进程中运行，不能在纯静态站点、Cloudflare Workers 等无法启动子进程的边缘运行时中生成回答。

## 从源码运行

```bash
npm install
npm run codex:login
npm run codex:status
npm run server
```

另开一个终端：

```bash
npm run dev
```

打开 <http://localhost:5173>。右上角 Codex 状态入口会显示 `已连接`、`未登录` 或 `不可用`；浏览器永远看不到 token、API Key 或认证文件内容。

若不想使用交互式登录，可把 `.env.example` 复制为 `.env` 并设置 `CODEX_API_KEY`。其余可选项：

| 变量 | 作用 |
|------|------|
| `PORT` | 本地代理端口，默认 `3001` |
| `VITE_PUBLIC_VIEWER_ORIGIN` | 可选的只读分享站点；未设时使用当前 origin |
| `CODEX_HOME` | 指定另一份 Codex 配置目录 |
| `CODEX_ENABLE_MCP` | 设为 `true` 才继承用户 Codex MCP；默认关闭 |
| `CODEX_MAX_CONCURRENCY` | 同时生成数，范围 1–8，默认 3 |

修改环境变量后需要重启 `npm run server`。

## 画布问答框如何映射到 Codex 任务

前台问答通过官方 Codex App Server 使用持久线程。一个问答框的当前问题/答案版本对应一个 turn，每个答案版本分别保存自己的 Codex thread ID 与 turn ID。映射按 DAG 结构进行，而不是把最新任务当成一条只能向前的线性聊天：

- 父框的首个普通子框 resume 父线程。
- 同一父框的其他子框，或显式分支，会从父 turn 精确 fork。
- 多路合流以及没有 Codex ID 的旧画布，会用当前连线选出的上下文 start 新线程。
- resume 前会检查锚点；若官方 Codex 客户端已在锚点之后追加 turn，ThoughtDAG 会从锚点自动 fork，不把两边历史接在一起。

后台摘要、记忆判断、凝练等机器任务不属于这条可见问答路径，仍使用一次性的隔离 SDK 线程。

```text
React 画布
  -> buildContext() 按连线遍历 DAG
  -> POST /api/stream（SSE）处理前台问答
  -> App Server start / resume / fork + 一个持久 turn
  -> POST /api/codex 处理隔离的非流式后台任务
```

在同一台机器并使用相同的 `CODEX_HOME` 与登录态时，这些持久前台任务可在官方 Codex 客户端里查看和继续。ThoughtDAG 沿用本机 Codex 的任务存储，不额外承诺跨设备同步，也不会让不同配置目录自动互通。

Codex 默认使用只读沙箱和 `approvalPolicy: "never"`。未选择项目时，工作目录是每次请求独立的临时空目录；桌面版可通过顶部项目菜单原生选择、切换或清除项目文件夹，再从工具栏选择权限：只读访问仅注入受限文件 MCP（列出、读取、搜索）；项目操作启用命令并只把所选项目加入持久可写根，本地命令不能联网；完全访问使用无沙箱文件/网络能力，并在切换时二次确认。只读和项目模式禁止加载项目指令；完全访问可以加载本地指令、技能和 hooks。命令环境采用运行时 core 环境策略。后台调用使用独立线程，但不能据此认为其权限一定比所选模式更小。图片始终写入独立临时目录，并在完成、失败或取消后清理。

全局 MCP 默认不继承，因为外部工具不受文件沙箱约束，可能产生写入或其他副作用。只有你明确设置 `CODEX_ENABLE_MCP=true`，并在画布上打开 MCP 开关时，才会启用 Codex 配置中的 MCP；这时需要自行信任并审计那些工具。仓库里的 `codex.config.example.toml` 给出了 mock server 的可选配置示例。

## 模型与联网搜索

界面通过 Codex App Server 的动态模型目录读取当前登录态可用的模型、默认模型、思考档位和速度能力。切换模型时，不兼容的旧思考档会回到“自动（模型默认）”；“快速”映射到 Codex 的 priority 服务层，“标准”显式映射到 default，不支持 Fast 的模型会安全回到标准档。服务端在生成前再次校验所有选择。旧画布里保存的其他供应商模型标记会安全回落到当前 Codex 默认值，但历史节点内容与来源字段不会被改写。

画布上的联网搜索开关会转成 Codex 的网页搜索模式。是否可用仍取决于本机 Codex 配置、账号与策略；应用不会退回到旧供应商或浏览器直连接口。

## 数据、认证与桌面版

- 画布及每个答案版本的 Codex thread / turn ID 保存在浏览器 IndexedDB，也可继续导入/导出 `.thoughtdag.json`。
- 打包后的桌面渲染端固定使用回环 origin `http://127.0.0.1:31173`。升级时会一次性合并旧 `31174` origin 留下的画布与附件记录，临时端口变化不再让项目看起来“消失”。
- `#view=` 分享内容仍只在 URL 片段中；源码本机运行未配置公共 viewer 时，链接只适合同一台机器。发布自己的只读站点后可设置 `VITE_PUBLIC_VIEWER_ORIGIN`。
- 文档文件本身不交给远程托管服务；只有当前连线选中的文本与请求图片会进入本机 Codex 调用链路。
- 源码版和桌面版复用原生 Windows/macOS/Linux 的 Codex 登录缓存。Windows 原生环境与 WSL 的用户目录不同，需要在运行应用的同一侧完成登录。
- 桌面版只把原生文件夹选择器返回的路径交给本机后端注册；渲染进程与生成接口仅持有运行期不透明项目 ID，服务重启后自动失效。
- 本地服务只监听回环地址，不应直接暴露到公网。

## 验收

```bash
npm run test:codex   # 假事件流，不消耗额度
npm run build
# 保持 `npm run server` 与 `npm run dev` 都在运行：
npm run smoke
```

真实回答测试需要 `npm run codex:status` 成功。若未登录，状态接口与生成错误会给出明确提示，不会静默切换模型。

## 本地 HTTP 与代理配置

服务拒绝非回环地址的 `HOST`。浏览器来源仅允许服务自身和本机 5173/4173 端口；使用其他开发端口时，按 `.env.example` 设置精确的 `THOUGHTDAG_ALLOWED_ORIGINS`，这不会开放远程托管。只有受信任的本机代理使用 fake-IP DNS 时，才显式设置 `THOUGHTDAG_ALLOW_FAKE_IP=true`；普通 DNS 保持关闭。
