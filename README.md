# CommitCraft

读取 **Git 暂存区**的变更，用你自己配置的大模型生成规范的 commit message，并对暂存区代码做一次提交前审查。

- 只看暂存区：`git add` 了什么就分析什么，不读未暂存改动
- 不锁厂商：OpenAI 兼容接口 / Anthropic / Azure OpenAI / 本地 Ollama
- 密钥不外泄：存进 VSCode 加密凭据库，不写 `settings.json`，不随 Settings Sync 同步
- 模型自动发现：内置 8 个服务商入口，选完自动 `GET /models` 拉可用模型，不用手查名字
- 提示词可改：内置 6 套模板，也可自定义，模板能写进 `.vscode/settings.json` 随仓库共享
- 审查有地方看：侧边栏清单 + 详细报告面板 + 状态栏计数，关掉面板还能重新打开
- 绝不自动提交：只写入源代码管理输入框，写前备份原草稿，一条命令可恢复

## 快速开始

1. 安装扩展后打开任意 Git 仓库。
2. `Ctrl+Shift+P` → **CommitCraft: 快速配置模型**，四步走完：选服务商（DeepSeek / OpenAI / 通义 / Kimi / 智谱 / Ollama / Claude / Azure）→ 填密钥 → 自动获取模型列表 → 选默认模型。
3. `git add` 要提交的文件，按 `Ctrl+Alt+G`（macOS `Cmd+Alt+G`）生成提交信息。
4. 按 `Ctrl+Alt+R` 审查暂存区代码，结果会出现在左侧 CommitCraft 图标下的「审查问题」里。

> 没配模型也能先跑：`commitCraft.model` 留空时会自动使用该服务商的推荐默认模型，并在执行时提示你用的是哪一个。

## 设置页面

25 个配置项平铺在 VSCode 设置里，看到的是 `commitCraft.diff.excludeGlobs` 这样的键名和一句话说明，既不知道改了会怎样，也不知道该填什么。所以扩展带了一个独立设置页：`Ctrl+Shift+P` → **CommitCraft: 打开设置页面**。

左边五个分区，右边表单，每一项都写清「改这个会发生什么」：

| 分区 | 管什么 |
| --- | --- |
| 模型服务 | 服务商、接口地址、模型、密钥、获取模型、测试连接 |
| 提交信息 | 格式、语言、模板、标题长度、是否生成正文、参考历史条数 |
| 代码审查 | 审查模板、最低报告级别、最多条数、是否打波浪线 |
| 上下文与隐私 | 总/单文件字符上限、排除的文件（glob）、是否脱敏 |
| 高级 | temperature、maxTokens、超时、重试次数 |

页面上能做的、原生设置做不到的四件事：

1. **带品牌图标的服务商卡片** —— DeepSeek / OpenAI / 百炼 / Kimi / 智谱 / Ollama / Claude / Azure 每张卡片都是等高等宽的「图标 + 名称 + 一行说明」，点一下自动填好接口地址与默认模型，不用去查 `baseUrl`。图标取自 [Lobe Icons](https://icons.lobehub.com) 的静态 SVG（MIT），内联进页面后继承 `currentColor`，深浅色主题都不会出现黑底黑字。
2. **密钥状态可见可改** —— 显示「已保存 sk-••••••1234」或「从环境变量 XXX 读取」，输入框直接替换，清除也在这里。密钥仍然只进凭据库。
3. **保存前校验** —— 超时填成 100ms、temperature 填成 5 这类值会被拦下并指出是哪一项，不会先写进 `settings.json` 再去排查。
4. **搜索与分组状态** —— 顶部搜索框跨分区过滤（试搜「超时」「glob」），每个分区在导航上带「已修改」计数。

模型分区按「① 选择服务商 → ② 连接与密钥 → ③ 验证连接」三步排，接口协议、模型列表、密钥环境变量这类低频选项收进底部「更多选项」，默认不占版面。

底部是「恢复本页默认」与「保存」。只有真正变化的项才会写入，且统一写全局作用域；若某些键被工作区级配置覆盖，页面顶部会直接说明。

需要直接改 JSON 或做团队共享配置时，用 **CommitCraft: 在 settings.json 中编辑** 打开原生设置界面。

## 审查结果在哪里看

三个入口，读的是同一份数据（存在 workspace 里，关窗重开还在）：

| 入口 | 位置 | 适用 |
| --- | --- | --- |
| **侧边栏清单** | 左侧活动栏 CommitCraft 图标 → 审查问题 | 逐条改代码，点一下跳到对应行 |
| **详细报告** | 审查完成自动打开；随时用「打开审查报告」再开 | 看摘要、按级别筛选、复制 |
| **状态栏** | 左下角 `3 个审查问题 · deepseek-chat`，点击打开报告 | 随时知道还剩几条没处理 |

编辑器里的波浪线（诊断）与侧边栏来自同一批问题；「清空审查结果」会一并清掉清单、报告、波浪线和存储。

## 命令

| 命令 | 快捷键 | 说明 |
| --- | --- | --- |
| CommitCraft: 生成提交信息 | `Ctrl+Alt+G` | 用默认模板生成并写入 SCM 输入框 |
| CommitCraft: 用指定模板生成提交信息 | — | 临时换一套模板 |
| CommitCraft: 审查暂存区代码 | `Ctrl+Alt+R` | 输出问题清单 + 报告 + 编辑器标注 |
| CommitCraft: 打开设置页面 | — | 分组配置所有选项 |
| CommitCraft: 在 settings.json 中编辑 | — | 打开原生设置界面 |
| CommitCraft: 快速配置模型 | — | 服务商 / 密钥 / 模型一次配好 |
| CommitCraft: 选择模型 | — | 自动获取模型列表后挑选，也可手填 |
| CommitCraft: 刷新可用模型列表 | — | 只刷新列表，不改当前模型 |
| CommitCraft: 设置 / 清除 API 密钥 | — | 写入 VSCode 凭据库 |
| CommitCraft: 测试模型连接 | — | 发一条最短请求验证配置 |
| CommitCraft: 打开审查报告 | — | 重新打开上一次的报告 |
| CommitCraft: 复制审查报告为 Markdown | — | 贴到 PR / 群里 |
| CommitCraft: 清空审查结果 | — | 清单 + 报告 + 波浪线一起清 |
| CommitCraft: 在侧边栏查看审查问题 | — | 聚焦问题清单 |
| CommitCraft: 取消当前请求 | — | 也可点状态栏 |
| CommitCraft: 恢复提交信息草稿 | — | 撤销上一次写入 |
| CommitCraft: 清除审查标记 | — | 只清波浪线 |

## 服务商配置

| provider | baseUrl 示例 | 密钥 | 说明 |
| --- | --- | --- | --- |
| `openai-compatible` | `https://api.openai.com/v1` | 需要 | 也适用于 DeepSeek / Qwen / Moonshot / 自建网关 |
| `anthropic` | `https://api.anthropic.com/v1` | 需要 | 使用 `x-api-key` 头 |
| `azure-openai` | `https://<resource>.openai.azure.com/openai` | 需要 | `model` 填 deployment 名称；不支持列举模型 |
| `ollama` | `http://localhost:11434` | 不需要 | 本地模型，如 `qwen2.5-coder:7b` |

> 如果 `baseUrl` 直接填到 `/chat/completions` 或 `/messages`，扩展会原样使用，不再拼接。

### 自动获取模型

「选择模型」和「快速配置模型」会自动调用服务商的模型列表接口：

| provider | 接口 | 说明 |
| --- | --- | --- |
| `openai-compatible` | `GET {baseUrl}/models` | `Authorization: Bearer` |
| `anthropic` | `GET {baseUrl}/models` | `x-api-key` + `anthropic-version` |
| `ollama` | `GET {baseUrl}/api/tags` | 无需密钥，`baseUrl` 带 `/api` 也能容错 |
| `azure-openai` | — | 无公开接口（deployment 属管理面），只能手填 |

- 结果缓存在 globalState（不进 `settings.json`），24 小时后再选会静默刷新；同一地址不会重复请求。
- 设置页里点「获取模型」后列表会直接展开，点任意一项即可选中；也可以点输入框右侧的箭头随时重开，边打字边过滤，`↑`/`↓` 移动、`Enter` 选中、`Esc` 收起。下拉里同时包含 `commitCraft.availableModels` 里手填的候选模型（接口不返回列表时尤其有用）。
- 列表按「适合写提交信息 / 审代码」排序（含 `coder`、`gpt-4`、`claude`、`deepseek` 等关键词的靠前），embedding / TTS / 图像模型排最后但不会隐藏。
- 拉不到（404、无权限、内网禁用）不影响使用：会提示原因并给出手动输入入口；可用 `commitCraft.autoFetchModels: false` 关掉自动请求。
- 各处给出的「推荐默认模型」只用于排序与预填，实际以接口返回为准。

常见服务商参考：

```jsonc
// DeepSeek
{ "commitCraft.provider": "openai-compatible",
  "commitCraft.baseUrl": "https://api.deepseek.com/v1",
  "commitCraft.model": "deepseek-chat" }

// 阿里云百炼（Qwen）
{ "commitCraft.baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "commitCraft.model": "qwen-plus" }

// 本地 Ollama
{ "commitCraft.provider": "ollama",
  "commitCraft.baseUrl": "http://localhost:11434",
  "commitCraft.model": "qwen2.5-coder:7b" }
```

## 主要配置

下面是最常改的几项。全部选项、可选值与推荐值都写在设置页里，改完即时校验。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `commitCraft.provider` | `openai-compatible` | 服务商类型 |
| `commitCraft.baseUrl` | `https://api.openai.com/v1` | 接口地址 |
| `commitCraft.model` | `gpt-4o-mini` | 模型名；**留空自动使用推荐默认模型** |
| `commitCraft.autoFetchModels` | `true` | 选模型时自动请求 `/models` |
| `commitCraft.availableModels` | `[]` | 仅补充接口没返回的模型，一般不用填 |
| `commitCraft.temperature` | `0.2` | 生成提交信息建议 0.1–0.3 |
| `commitCraft.requestTimeoutMs` | `60000` | 超时时间 |
| `commitCraft.maxRetries` | `1` | 429 / 5xx / 网络错误重试次数 |
| `commitCraft.apiKeyEnv` | `""` | 从环境变量读密钥，优先于凭据库 |
| `commitCraft.commit.format` | `conventional` | `conventional` / `angular` / `gitmoji` / `plain` / `custom` |
| `commitCraft.commit.language` | `auto` | `auto` 跟随 VSCode 语言 |
| `commitCraft.commit.templateId` | `builtin-conventional-zh` | 生成用模板 |
| `commitCraft.commit.confirmBeforeInsert` | `false` | 写入前先预览确认 |
| `commitCraft.diff.excludeGlobs` | lockfile / 构建产物 | 不发给模型的文件 |
| `commitCraft.diff.maxTotalChars` | `48000` | 发送内容的字符上限 |
| `commitCraft.review.minSeverity` | `low` | 报告最低级别 |
| `commitCraft.review.showDiagnostics` | `true` | 是否在编辑器标注问题 |

完整列表见设置页面。

配置与服务商明显不匹配时（例如 provider 是 Ollama 但地址填了 `api.openai.com`），执行时会给出具体提示，而不是发一个注定失败的请求。

## 自定义提示词模板

```jsonc
{
  "commitCraft.customTemplates": [
    {
      "id": "team-fe",
      "type": "commit",
      "name": "前端组规范",
      "systemPrompt": "你是资深前端工程师，只输出提交信息本身。",
      "userPrompt": "仓库：{{repoName}} 分支：{{branch}}\n最近提交：\n{{recentCommits}}\n\n变更文件：\n{{stagedFiles}}\n\n请按 {{format}} 生成 commit message，语言 {{language}}，首行不超过 {{maxSubjectLength}} 字符。\n\nDiff：\n{{diff}}"
    }
  ]
}
```

可用变量：`{{diff}}` `{{stagedFiles}}` `{{fileStats}}` `{{repoName}}` `{{branch}}` `{{recentCommits}}` `{{language}}` `{{format}}` `{{maxSubjectLength}}` `{{bodyInstruction}}` `{{truncated}}`

- `userPrompt` **必须**包含 `{{diff}}`，否则模板会被拒绝
- 未知变量按空串处理，并在日志里告警
- 同 `id` 时自定义模板覆盖内置模板
- 把这段写进仓库的 `.vscode/settings.json`，团队就统一了规范

## 隐私与安全

- 只有你主动执行命令时才会发起网络请求，扩展不做任何后台轮询。
- 发送内容 = 暂存区 diff + 文件清单 + 分支名 + 最近几条提交标题。你的仓库地址、文件路径以外的信息不会外发。
- 密钥存于 `context.secrets`（系统凭据管理），**不写入任何设置文件**，也不进 Settings Sync。
- 默认开启脱敏：`sk-*`、AWS key、GitHub token、JWT、`Bearer`、私钥块、`password = "…"` 一类赋值会在发送前替换为 `***REDACTED***`。
- 日志对 `Authorization` / `api-key` / `x-api-key` 做硬屏蔽。
- 使用非 `localhost` 的 `http://` 地址时会提示明文传输风险。
- 默认不采集任何遥测。

## 已知限制

- 只处理暂存区，未暂存改动不会进入上下文（这是刻意设计）。
- 二进制文件、lockfile、构建产物默认不发送内容，只列文件名。
- 超大变更按文件丢弃 + 单文件截断，报告里会明确提示，此时生成质量可能下降。
- 审查结果依赖模型能力，行号越界的条目会被降级为文件级而不是硬标一行。
- Azure OpenAI 无法自动列举模型，需要手填 deployment 名称。
- 审查结果是「上一次运行的结果」快照：改完代码后需要重新审查才会更新。
- 暂不支持 Chat 式二次改稿、PR 描述生成、一键应用修复。

## 开发

```bash
npm install
npm run check:icons # 校验所有 $(codicon) 名字真实存在
npm run compile   # 类型检查
npm run test      # 单元 + 真实 git 集成测试（158 项）
npm run build     # esbuild 打包到 dist/extension.js
npm run verify    # 图标名校验 + 类型 + 单测 + 打包 + 冒烟 + 四条端到端
npm run icon      # 从 media/icon-source.jpg 导出图标（需 Pillow + numpy）
npm run icons:providers # 重新拉取服务商图标到 media/providers（需联网）
npm run preview:settings # 生成设置页的静态预览（preview/settings-page.html，跟随系统深浅色）
npm run package   # 生成 .vsix
```

### 发布

发布流水线对应开发计划 §6，所有检查项代码化在 `scripts/publish.js`：

```bash
npm run preflight    # 只跑 §6.2 检查清单（版本/CHANGELOG/图标/分类/README/包内容/远端占用）
npm run release:dry  # 检查 + verify + 生产构建 + 打包，不推送
npm run release:pre  # 推送 Marketplace 预发布渠道（灰度）
npm run release      # 正式发布：Marketplace + Open VSX
npm run release:vsix # 只产出 .vsix
```

令牌只走环境变量，不要写进仓库：

| 变量 | 用途 | 获取 |
| --- | --- | --- |
| `VSCE_PAT` | Visual Studio Marketplace | [Azure DevOps](https://dev.azure.com) → Personal access tokens，Scope 选 Marketplace → Manage；发布者需先在 [manage 页面](https://marketplace.visualstudio.com/manage) 创建 |
| `OVSX_PAT` | [Open VSX](https://open-vsx.org)（VSCodium / 国产 IDE） | [访问令牌](https://open-vsx.org/user-settings/tokens)，命名空间需先创建 |

```bash
VSCE_PAT=xxx OVSX_PAT=yyy npm run release
```


`npm run e2e` 里的设置页用例会用 jsdom 真正执行 webview 脚本，验证的是「点一下服务商卡片 → 点保存 → 配置被写入」这条完整链路，不只是断言宿主收到了消息。

架构分四层，依赖单向向下：

- `src/domain/` 纯逻辑，不 import `vscode`，可脱离扩展宿主单测
- `src/infra/` Git 采集、模型适配、配置与密钥、日志
- `src/app/` 用例编排
- `src/ui/` 状态栏、SCM 输入框、诊断、Webview 报告与设置页

按 `F5` 在扩展开发宿主里调试。

## License

MIT
