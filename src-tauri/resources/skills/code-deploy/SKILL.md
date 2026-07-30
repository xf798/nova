---
name: code-deploy
description: 代码提交、审查与部署技能。支持 Gerrit Code-Review（列出待审变更、批量 +2）和 Jenkins 构建部署（触发前端项目打包发布到指定环境）。当用户提到"提代码"、"审代码"、"Code-Review"、"CR"、"帮我review"、"帮我+2"、"outgoing reviews"、"部署"、"deploy"、"发布"、"打包"、"构建"、"build"、"上线"、"发到dev"、"发到test"、"发环境"、"jenkins"时触发。
metadata:
  requires:
    bins: ["bash", "curl", "python3"]
---

# 代码提交、审查与部署

整合 Gerrit Code-Review 和 Jenkins 构建部署能力，完全独立运行，无外部仓库依赖。

## 目录结构

```
~/.pipeline-commander/skills/code-deploy/
├── SKILL.md                          # 本文件
├── config/
│   ├── sso_config.json               # SSO 登录凭据（Gerrit 认证用）
│   ├── sso_config.example.json       # SSO 配置模板
│   ├── jenkins_config.json           # Jenkins 凭据
│   └── jenkins_config.example.json   # Jenkins 配置模板
├── scripts/
│   ├── run_gerrit_review.sh          # Gerrit Review 入口（自动管理 venv）
│   └── gerrit_review.py              # Gerrit Review 核心逻辑
└── .venv/                            # 自动创建的 Python venv（含 Playwright）
```

---

## 一、Gerrit Code-Review

### 概述

在 Gerrit（`https://gerrit.ingageapp.com`）上完成：
1. 列出当前用户提交的未合入变更（Outgoing Reviews）
2. 对指定 change 批量提交 Code-Review +2

### 配置

编辑 `~/.pipeline-commander/skills/code-deploy/config/sso_config.json`：

```json
{
  "username": "your-email@company.com",
  "password": "your-password",
  "company": "公司名（多公司选择时用）"
}
```

首次运行时，脚本会自动创建 Python venv 并安装 Playwright + Chromium。

### 执行流程

#### 第 1 步：获取 Outgoing Reviews

```bash
bash ~/.pipeline-commander/skills/code-deploy/scripts/run_gerrit_review.sh --list
```

输出 JSON 格式的 change 列表，包含 `id`、`number`、`project`、`branch`、`subject`、`url`。

#### 第 2 步：展示列表并让用户选择

将 change 列表以可读格式展示：

```
序号 | 项目 | 分支 | 标题 | 链接
```

询问用户要对哪些 change 执行 Code-Review +2。

**⚠️ 必须**得到用户明确确认后再执行；不得默认全选。

#### 第 3 步：执行 Code-Review +2

```bash
bash ~/.pipeline-commander/skills/code-deploy/scripts/run_gerrit_review.sh --review "<change_id_1>" "<change_id_2>"
```

#### 第 4 步：汇报结果

展示每个 change 的 review 结果（成功/失败），失败时附带错误摘要。

### 注意事项

- **Code-Review +2 是强权限操作**，执行前必须让用户确认
- 若账号无 +2 权限，API 会返回错误
- `change_id` 使用 `--list` 结果中每条记录的 `id` 字段

---

## 二、Jenkins 构建部署

### 概述

通过 Jenkins REST API 触发前端项目的打包部署（`federation_publish` Job）。

### Jenkins 信息

| 字段 | 值 |
|------|-----|
| API 端点 | `https://fe-dev-tools.ingageapp.com/jenkins/job/federation_publish/buildWithParameters` |
| 认证方式 | HTTP Basic Auth |
| 构建历史 | `https://fe-dev-tools.ingageapp.com/jenkins/job/federation_publish/` |

### 配置

编辑 `~/.pipeline-commander/skills/code-deploy/config/jenkins_config.json`：

```json
{
  "jenkins_username": "your-username",
  "jenkins_password": "your-password",
  "default_publisher": "your-name@neocrm.com",
  "skip_confirm": false
}
```

### 必填参数

| 参数 | 说明 |
|------|------|
| projects | 要构建的项目（逗号分隔），支持简称 |
| branch | 分支名：hotfix/master/develop/monthly/release/mr-release |
| publisher | neocrm.com 邮箱 |

### 可选参数

| 参数 | 说明 |
|------|------|
| environment | 部署环境：空/crm-cd/crm-ci/dev/devsandbox/test/stress/mrdev/mrci/mrcd/tencentuat/devpod20 |

### 项目简称映射（多对一）

用户输入任意一个简称/别名均可匹配到对应全名，匹配策略：精确匹配 > 包含匹配 > 候选列表。

| 全名 | 可匹配的简称/别名 |
|------|-------------------|
| neo-ui-component-h5 | `h5`, `component-h5`, `组件h5` |
| neo-ui-component-web | `web`, `component-web`, `组件web` |
| neo-ui-component-bi | `bi`, `component-bi`, `bi组件` |
| neo-ui-h5component-basebi | `basebi-h5`, `basebi h5`, `基础bi h5` |
| neo-ui-webcomponent-basebi | `basebi-web`, `basebi web`, `基础bi web` |
| neo-ui-component-sfa-h5 | `sfa-h5`, `sfa h5`, `sfah5` |
| neo-ui-component-sfa-web | `sfa-web`, `sfa web`, `sfaweb` |
| neo-ui-component-h5-scrm | `scrm-h5`, `scrm h5`, `scrmh5` |
| neo-ui-component-web-scrm | `scrm-web`, `scrm web`, `scrmweb` |
| neo-ui-component-prm-h5 | `prm-h5`, `prm h5`, `prmh5` |
| neo-ui-component-prm-web | `prm-web`, `prm web`, `prmweb` |
| neo-ui-component-servicecloud-h5 | `sc-h5`, `sc h5`, `servicecloud-h5`, `servicecloud h5`, `服务云h5` |
| neo-ui-component-servicecloud-web | `sc-web`, `sc web`, `servicecloud-web`, `servicecloud web`, `服务云web` |
| neo-ai-copilot-fe-h5 | `copilot-h5`, `copilot h5`, `ai助手h5`, `ai-h5` |
| neo-ai-copilot-fe-web | `copilot-web`, `copilot web`, `ai助手web`, `ai-web`, `fe-web` |
| neo-ai-native-h5 | `native-h5`, `ai native h5`, `ainative-h5`, `ai原生h5` |
| neo-ai-native-web | `native-web`, `ai native web`, `ainative-web`, `ai-native`, `ai原生web` |
| neo-ui-designer-h5 | `designer-h5`, `designer h5`, `设计器h5` |
| neo-ui-designer-web | `designer-web`, `designer web`, `设计器web` |
| neo-ui-admin-platform | `admin`, `admin-platform`, `管理平台` |
| neo-ui-admin-ai | `admin-ai`, `adminai`, `ai管理` |
| neo-ui-admin-sfa | `admin-sfa`, `adminsfa`, `sfa管理` |
| neo-ui-admin-prm | `admin-prm`, `adminprm`, `prm管理` |
| neo-platform-ui-h5 | `platform-h5`, `platform h5`, `平台h5` |
| neo-ui-web-static-mf | `static-mf`, `mf`, `微前端`, `static` |
| neobase | `neobase`, `base` |
| neoreact | `neoreact`, `react` |
| neo-ui-icon | `icon`, `图标` |
| apps-ingage-web | `ingage`, `ingage-web` |
| xsy-paas-ui-webadmin | `webadmin`, `paas-admin`, `paas管理` |
| xsy-breeze-vsc-tools | `breeze-vsc`, `breeze`, `vsc-tools`, `vsc工具` |
| neo-prm-register-fe | `prm-register`, `prm注册`, `注册` |
| neo-apps-materialcenter-fe | `material`, `素材中心`, `materialcenter` |

**匹配规则**：
1. 用户输入精确等于某个别名 → 直接命中
2. 用户输入被全名包含，或包含某个别名关键词 → 列为候选
3. 多个命中时（如输入 `sfa` 匹配 `sfa-h5`、`sfa-web`、`admin-sfa`）→ 展示候选列表让用户选择
4. 无法匹配 → 展示完整项目清单供用户选择

### Branch ↔ Environment 映射

| branch | environment |
|--------|-------------|
| develop | crm-cd |
| hotfix | tencentuat |
| mr-release | test |

推导规则：
- 只给了 branch 没给 environment → 自动推导
- 只给了 environment 没给 branch → 反查推导
- 两个都给了 → 以用户输入为准

### 执行流程

#### 第 1 步：参数校验

从用户输入中提取并校验：
- `projects`（必填）：匹配项目清单，支持简称
- `branch`（必填）：必须是合法分支名
- `publisher`（必填）：未提供则使用 config 中的 `default_publisher`
- `environment`（可选）：尝试通过映射自动推导

#### 第 2 步：确认构建参数

若 `skip_confirm` 非 `true`，向用户展示即将执行的参数并等待确认：

```
即将触发 Jenkins 构建：
  项目: xxx
  分支: xxx
  发布者: xxx
  环境: xxx
确认执行？
```

#### 第 3 步：触发构建

读取 `~/.pipeline-commander/skills/code-deploy/config/jenkins_config.json` 中的凭据，执行：

```bash
curl -s -w "\nHTTP_CODE:%{http_code}" \
  -u "{jenkins_username}:{jenkins_password}" \
  -X POST \
  "https://fe-dev-tools.ingageapp.com/jenkins/job/federation_publish/buildWithParameters" \
  --data-urlencode "projects={projects}" \
  --data-urlencode "branch={branch}" \
  --data-urlencode "publisher={publisher}" \
  --data-urlencode "environment={environment}" \
  --data-urlencode "ops=" \
  --data-urlencode "GERRIT_CHANGE_URL="
```

- HTTP 201 = 构建已入队成功
- 其他状态码 = 失败

#### 第 4 步：汇报结果

查询构建编号：

```bash
curl -s -u "{jenkins_username}:{jenkins_password}" \
  "https://fe-dev-tools.ingageapp.com/jenkins/job/federation_publish/api/json" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['nextBuildNumber'])"
```

向用户提供：
- 构建编号
- 控制台链接: `https://fe-dev-tools.ingageapp.com/jenkins/job/federation_publish/{buildNumber}/console`

---

## 三、典型工作流

### 工作流 1：审查代码并 +2

**用户**: "帮我看看有哪些待审的代码" / "帮我 CR +2"

1. 执行 `--list` 获取 Outgoing Reviews
2. 展示列表
3. 用户选择后执行 `--review`
4. 汇报结果

### 工作流 2：部署前端项目

**用户**: "帮我把 copilot-web 发到 dev" / "部署 ai-h5 到 test 环境"

1. 解析项目名（简称映射）、分支、环境
2. 自动推导缺失参数
3. 确认后触发 Jenkins 构建
4. 汇报构建编号和控制台链接

### 工作流 3：审查 + 部署（完整流程）

**用户**: "帮我把代码 +2 然后部署到 dev"

1. 先执行 Code-Review 流程
2. 确认 +2 成功后，执行部署流程

---

## 四、初始化指南

首次使用需要配置凭据：

### 1. SSO 配置（Gerrit 登录用）

```bash
# 编辑配置文件
vim ~/.pipeline-commander/skills/code-deploy/config/sso_config.json
```

填入 SSO 账号密码。首次运行 Gerrit 命令时会自动安装 Playwright 环境。

### 2. Jenkins 配置

```bash
vim ~/.pipeline-commander/skills/code-deploy/config/jenkins_config.json
```

填入 Jenkins 用户名、密码和默认发布者邮箱。

---

## 五、异常处理

| 场景 | 处理 |
|------|------|
| Gerrit 未登录 | 脚本自动走 SSO 登录流程 |
| SSO 配置缺失 | 提示用户编辑 `config/sso_config.json` |
| 无 +2 权限 | 展示 API 错误信息 |
| Jenkins 认证失败 (401/403) | 提示检查 `config/jenkins_config.json` |
| 项目名无法匹配 | 展示完整项目清单让用户选择 |
| 分支名不合法 | 提示合法的分支名列表 |
| venv 不存在 | 自动创建并安装依赖 |
| Playwright 未安装 | 自动安装 |
