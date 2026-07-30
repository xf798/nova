# Pipeline Commander

> PRD → 设计 → 代码 端到端自动化流水线控制客户端

## 技术栈

- **前端**: React 18 + TypeScript + TailwindCSS
- **后端**: Rust + Tauri 2
- **形态**: macOS Menu Bar App + 主窗口

## 功能

- 📊 流水线总览（状态/进度/耗时）
- 🔔 TCHub 变更监控（实时事件流）
- ⚡ 快捷操作（启动/暂停/重跑/跳过）
- 🎛️ 工程 Agent 状态管理
- 📈 核心指标看板
- ⚙️ 配置管理

## 开发

### 前置条件

- Node.js >= 18
- Rust >= 1.70
- macOS (Xcode Command Line Tools)

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run tauri dev
```

### 构建

```bash
npm run tauri build
```

## 项目结构

```
pipeline-commander/
├── src-tauri/           # Rust 后端
│   ├── src/
│   │   ├── main.rs      # 入口
│   │   ├── lib.rs       # Tauri 命令 + 插件
│   │   └── models.rs    # 数据结构
│   ├── Cargo.toml
│   └── tauri.conf.json  # Tauri 配置
├── src/                 # React 前端
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── TchubMonitor.tsx
│   │   └── Settings.tsx
│   ├── components/
│   │   └── PipelineCard.tsx
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## 关联项目

- [ai-pm-team](../ai-pm-team/) - PRD 产出
- [ai-ux-team](../ai-ux-team/) - 设计产出
- [ai-develop-team](../ai-develop-team/) - 代码生成
- [schemas/](../schemas/) - PRD-IR + Handoff 协议定义
