# Nova

> AI Native 研发工作台 —— 桌面客户端

Nova 不是编辑器，也不自带模型。它是一个**编排层**：把已有的 coding agent（kiro-cli、OpenAI 兼容 API）包装成可切换的连接器，在上面叠加长期记忆、技能、企微远程通道和自动化流水线，并把自身能力通过 MCP 暴露给 Agent 调用。

## 能力

**多连接器** —— kiro-cli（ACP 协议）、任意 OpenAI 兼容 API、企微机器人（消息通道）。每个会话持有独立实例与独立模型选择，互不干扰。

**记忆** —— 跨会话长期记忆；本地语义召回（嵌入模型可选下载，不打进安装包）与关键词召回按 RRF 融合；会话蒸馏把对话沉淀为记忆/技能/工作流。

**技能** —— Markdown 定义，按路径与关键词自动触发，用于接入外部系统（代码评审、构建发布、文档平台等）。

**会话** —— JSONL 增量存储；Rust 侧直扫磁盘全文搜索（不受前端分页限制）；分页加载、长消息折叠、过程时间线（正文/思考/工具调用按真实顺序渲染）。

**企微机器人** —— 从 IM 远程驱动本机 Agent；可配置使用范围（成员白名单）与敏感操作拦截（本地文件、命令执行、隐私数据等分类开关）。

**Agent 可操控工作台** —— 内置 MCP Server 把页面跳转、截图、连接器切换、流水线控制等注册为工具。

**内置插件** —— AutoProgram（PRD → 设计 → 代码 流水线）、Workspace（工作区与终端）。

**其他** —— 任务管理、Playbook 半自动执行、后台调度、Tauri updater 自动更新。

## 技术栈

React 18 + TypeScript + TailwindCSS + Zustand / Rust + Tauri 2 / Vitest

## 代码分布

```
src/
  connectors/        连接器抽象与实现（kiro-cli / openai-api / wecom-bot）、实例池、过程时间线
  core/              业务核心
    memory/          长期记忆、语义召回、召回闸门
    distill/         会话蒸馏（水位线增量）
    skills/          技能加载与注册
    tools/           工具注册与编排（含 coding tools 前端侧）
    commands/        slash 命令
    task/ playbook/ scheduler/   任务、可执行工作流、后台调度
    sendMessage.ts   发送主链路（上下文组装 → 连接器 → tool loop → 后处理）
    sessionStore.ts  会话状态（单一真相源）
    sessionStorage.ts JSONL 存储读写
  pages/             页面（ChatView / Connectors / Settings / Tasks / Plugins）
  shell/             外壳（侧边栏、主内容区、预览面板）
  hooks/             企微桥接、MCP 桥接、初始化、工具注册
  plugins/           插件系统与内置插件（pipeline / workspace）

src-tauri/src/
  lib.rs             Tauri 命令入口（会话存储、配置、系统能力等）
  coding_tools.rs    文件读写/编辑、命令执行、glob、grep
  embedding.rs       本地嵌入模型推理与向量存储
  downloader.rs      模型下载（含加速源）
  mcp_server.rs      MCP Server
  wecom.rs           企微机器人长连接

scripts/release.sh   发版（版本号校验 → 构建 → 签名 → 上传 → 验证更新源）
```

## 开发

前置：Node.js >= 18、Rust >= 1.70、macOS（Xcode Command Line Tools）

```bash
npm install
npm run tauri dev            # 开发
npm test                     # 前端测试（vitest run）
cd src-tauri && cargo test   # Rust 测试
npm run tauri build          # 构建
scripts/release.sh           # 发版，用法见脚本内注释
```
