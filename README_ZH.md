# ThoughtDAG Codex

**把 Codex 对话、项目操作和资料阅读放进可编辑画布的本地工作区。**

你可以从某条回答继续提问或创建分支，把文档接入问题，选择下一轮所需的上下文，并在图中继续处理 Codex 任务。本项目将 ThoughtDAG 的画布对接到官方 Codex App Server 与 SDK。

这是基于 [ThoughtDAG](https://github.com/chenxiachan/thoughtdag) 独立维护的社区衍生版本，与 OpenAI 及 ThoughtDAG 原作者无官方隶属或背书关系。

[English](README.md) · [配置说明](docs/setup_ZH.md) · [安全说明](SECURITY.md) · [上游项目](https://github.com/chenxiachan/thoughtdag)

## 这个版本能做什么

- **在画布里运行 Codex**：前台问答保留持久任务，自动摘要等后台请求使用隔离的 SDK 调用。
- **继续或分支处理任务**：继续主对话，也可以从指定回答创建分支；接入多个上下文路径时，用所选图内容创建新任务。
- **导入本机 Codex 对话**：桌面版可列出和导入本机任务。在同一台电脑、同一份配置下，兼容的持久任务也可在其他 Codex 客户端继续。
- **选择项目和权限**：桌面版通过原生对话框选择项目目录，默认只读；项目操作和完全访问由用户明确选择。
- **使用账号实际可用的模型**：模型、思考档位与 Fast 能力从运行时读取，不额外解锁账号未提供的功能。
- **保留画布与资料能力**：支持 PDF、DOCX、图片、HTML 和网页快照，保留回答版本、编辑内容、排列分支，并导出图备份或 Markdown。

## 本版本新增与优化

- **节点内容浏览进度保存**：节点卡片、展开阅读、侧边面板和资料阅读器会在本机保存滚动位置。切换节点或重新打开应用后可接着阅读，不同回答版本分别保存位置。
- **树状图整理**：一键将对话按分支整理为向下展开的树状图，主线对齐、同级分支分开排列；保留资料卡片的位置和原有图关系，支持撤销整理。
- **节点间连线优化**：曲线自动绕开可见卡片，对齐的节点使用直线。选中连线后可以拖动调整曲线、恢复默认形状、反转方向或删除，调整后的曲线会保存。
- **导入／导出对话**：桌面版可导入本机 Codex 任务；支持恢复 ThoughtDAG JSON 备份，以及导入兼容的 ChatGPT／Claude 导出文件。画布可导出为 JSON 备份，选中节点或上下文链可导出为 Markdown，方便迁移、阅读和分享。
- **代码块复制修复**：复制按钮提取代码正文并保留换行；桌面环境拒绝 Clipboard API 时自动尝试兼容方式，复制后恢复焦点与选区，失败时显示提示，避免误报成功。

## 与 ThoughtDAG 的关系

| 方面 | 本 Codex 对接版本 |
| --- | --- |
| 项目基础 | 沿用 ThoughtDAG 的画布、文档阅读和图交互能力 |
| 执行方式 | 通过本地 Codex 运行时执行；移除了浏览器端供应商密钥管理 |
| 任务存储 | 画布使用本机 IndexedDB；持久 Codex 任务还写入本机 Codex 任务存储 |
| 发布维护 | 独立维护、独立版本，不使用上游的自动更新或安装包 |
| 在线部署 | 静态托管只提供只读查看，不能运行本地 Codex |

新任务由画布选择输入上下文。续接已有 Codex 任务时，还会保留该任务的工具和媒体历史，其中一部分可能没有显示在卡片里。适配层负责处理结构分支和路径变化，因此不能把“图上可见内容”理解为运行时全部状态。

## 从源码运行

需要 **Node.js 22.12+**、npm，以及可用的 Codex 登录或你自己的 `CODEX_API_KEY`。模型权限和用量限制由账号决定。可选安装 Poppler，并让 `pdftoppm` 位于 PATH 中，以启用服务端 PDF 页面图片渲染。

```bash
git clone https://github.com/ggghhh16/thoughtdag-codex.git
cd thoughtdag-codex
npm ci
npm run codex:login
npm run server
```

另开一个终端，进入同一目录：

```bash
npm run dev
```

打开 <http://localhost:5173>。可用 `npm run codex:status` 检查登录状态。项目使用固定版本的运行时，并复用本机 Codex 登录与配置；仓库不包含登录凭据。需要覆盖配置时，参考 [.env.example](.env.example) 创建仅在本机使用的 `.env`。

### 启动桌面开发版

```bash
npm --prefix desktop ci
npm run desktop
```

该命令构建前端并启动 Electron。原生项目目录选择和本机任务导入属于桌面功能。安装包构建方式与平台要求见 [desktop/README.md](desktop/README.md)。源码公开不代表已经提供当前版本的签名安装包；请只使用本仓库发布的附件。

## 权限和数据去向

| 模式 | 实际行为 |
| --- | --- |
| 只读（默认） | 关闭本地命令和编辑工具；内置项目读取工具限定在所选目录内，并排除常见凭据文件 |
| 项目操作 | 本地命令可写所选项目及临时工作目录，关闭命令联网；这是写入限制，不保证其他本机文件完全不可读 |
| 完全访问 | 本地工具可访问其他文件与网络；界面会要求确认 |

外部 MCP **默认关闭**，必须同时设置 `CODEX_ENABLE_MCP=true` 并开启画布上的 MCP 开关。外部工具有自己的访问能力，不受本地命令文件沙箱完整约束。

- 画布和附件保存在本机。提问时，上下文、选中附件以及被允许的工具结果可能发送到配置的 Codex 服务。
- 抓取网页会访问来源网站。HTML 快照阅读器禁止脚本和远程子资源，因此显示效果可能与原网页不同。
- HTTP 服务只监听本机回环地址，并拒绝不可信 Host/Origin。这是单用户本地应用，**没有面向多用户的身份认证**；以你的用户身份运行的本地程序仍属于信任范围。
- 备份、导出文件和分享链接可能包含对话或文档内容，分享前请检查。
- 运行时配置、凭据、`.env`、本地对话和构建缓存不属于发布内容。审查范围和限制见 [SECURITY.md](SECURITY.md)。

## 开发检查

```bash
npm test
npm run build
npm audit
npm --prefix desktop audit
```

测试使用本地样例，不消耗模型额度。真实模型调用需要单独登录。`scripts/` 中另有界面冒烟检查，部分需要本机安装 Chrome。

## 致谢与许可

项目基于 Xia Chen 的 [ThoughtDAG](https://github.com/chenxiachan/thoughtdag)，保留原版权声明和 [MIT 许可证](LICENSE)。官方 Codex 组件遵循各自许可证，其中 SDK 为 Apache-2.0。参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
