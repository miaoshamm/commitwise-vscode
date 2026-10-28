# 实现进度对照

对照 `CommitCraft-VSCode插件开发计划.md` 的阶段划分，记录已落地与未落地内容。最后更新：2026-10-26（v0.4.1）。

## 一、总体状态

| 计划阶段 | 状态 | 说明 |
| --- | --- | --- |
| P0 基建 | ✅ 完成 | 脚手架、esbuild、tsconfig、vitest、Git 采集、Diff 过滤/裁剪/脱敏、Token 预算、日志 |
| P1 生成闭环 | ✅ 完成 | 4 类 Provider 适配、SSE 流式、密钥存储、配置校验、生成 + 校验 + 写入输入框 + 草稿恢复 |
| P2 多模型与模板 | ✅ 完成 | 4 类适配器齐备、**模型自动发现 + 快速配置向导**、连接测试、6 套内置模板 + 自定义、状态栏、取消/重试 |
| P3 代码审查 | ✅ 完成 | JSON 输出 + 修复重试、行号合法性校验、**侧边栏清单 + 报告面板 + 诊断三出口**、点击跳转 |
| P4 打磨 | 🟡 部分 | 脱敏、产物瘦身、文档、CHANGELOG、Markdown 导出已完成；i18n 与遥测未做（见"未实现"） |
| P5 发布 | 🟡 部分 | 发布前检查、打包、本地安装走查全部通过；Marketplace 推送需要 publisher 与 PAT（见"发布状态"） |

## 二、计划内功能落地情况

| 编号 | 功能 | 状态 | 代码位置 |
| --- | --- | --- | --- |
| F1 | 暂存区变更采集 | ✅ | `src/infra/git/diffCollector.ts` |
| F2 | Commit 信息生成 | ✅ | `src/app/generateCommit.ts` |
| F3 | 写入 SCM 输入框 | ✅ | `src/ui/scmInputBridge.ts` |
| F4 | 模型配置 | ✅ | `package.json` + `src/infra/config/configTypes.ts` |
| F5 | 密钥安全存储 | ✅ | `src/infra/config/configService.ts`（`SecretStore`） |
| F6 | 提示词模板系统 | ✅ | `src/domain/prompt/*` |
| F7 | 暂存区代码审查 | ✅ | `src/app/reviewStaged.ts` |
| F8 | 结果可视化 | ✅ | `src/ui/reviewTreeProvider.ts` + `reviewPanel.ts` + `diagnosticsBridge.ts` + `reviewStore.ts` |
| F9 | Diff 过滤与截断 | ✅ | `src/domain/diff/prepareDiff.ts` |
| F10 | 请求取消与超时 | ✅ | `src/app/cancellation.ts` + `src/infra/ai/streamClient.ts` |
| F11 | 多仓库支持 | ✅ | `src/infra/git/repoLocator.ts` |
| F12 | 敏感信息脱敏 | ✅ | `src/domain/diff/redact.ts` |
| F13 | 连接测试 | ✅ | `src/commands/index.ts` → `pingModel` |
| F14 | 审查结果导出 | ✅ | `src/domain/review/reviewMarkdown.ts` + `commitCraft.copyReviewMarkdown`（剪贴板；未落盘文件） |
| F15 | 中英文界面 | ❌ 未做 | 当前界面文案为中文硬编码，未接入 `l10n` |
| F16 | 可选埋点 | ❌ 未做 | 配置项已预留，无上报实现（默认关闭） |
| F17 | 问题快速修复 | ❌ 未做 | 报告只展示建议，未提供 Code Action 应用 |

### v0.2.0 新增（用户反馈驱动）

| 能力 | 位置 |
| --- | --- |
| 快速配置模型（8 个服务商入口，四步向导） | `src/commands/modelCommands.ts` + `src/infra/config/providerPresets.ts` |
| 自动获取模型列表（`/models`、`/api/tags`）+ 排序 + 24h 缓存 | `src/infra/ai/modelCatalog.ts`、`modelStore.ts` |
| 默认模型回填与配置提示（留空不再报错） | `src/infra/config/configTypes.ts` |
| 服务商与地址不匹配检测 | `providerPresets.ts` → `detectConfigMismatch` |
| 审查问题侧边栏（TreeView） | `src/ui/reviewTreeProvider.ts` |
| 审查结果持久化 + 随时重开报告 | `src/ui/reviewStore.ts`、`commitCraft.showReviewReport` |
| 报告 Markdown 导出 | `src/domain/review/reviewMarkdown.ts` |
| 状态栏同时承载模型与问题数 | `src/ui/statusBarController.ts` + `src/app/statusSync.ts` |

### v0.4.1 新增（模型下拉与下拉框统一）

| 能力 | 位置 |
| --- | --- |
| 模型自绘 combobox（输入框 + 常驻箭头 + 浮层列表） | `settingsPanel.ts` → `modelPickerOptions` / `toggleModelPop` / `pickModel` |
| 列表合并接口模型与 `availableModels` 手填项 | `modelPickerOptions()` |
| 边打字边过滤、↑↓ / Enter / Esc / 点空白关闭 | `filterModelList` / `moveModelActive` + `keydown` |
| 原生 select 统一外观（appearance:none + 自绘箭头） | `STYLE` → `.select-wrap` |
| 面板 overflow 放开，避免裁掉浮层 | `STYLE` → `.panel` |

### v0.4.0 新增（设置页视觉与服务商图标）

| 能力 | 位置 |
| --- | --- |
| 服务商品牌图标（内联 SVG，跟随主题色） | `src/ui/providerIcons.ts` + `media/providers/*.svg` |
| 图标拉取与规整（去尺寸/样式，强制 currentColor） | `scripts/fetch-provider-icons.js`（`npm run icons:providers`） |
| 三步式模型分区（选服务商 → 连接与密钥 → 验证） | `settingsPanel.ts` → `renderModelSection` |
| 面板化分组 + 「更多选项」折叠区 | `STYLE` 中的 `.panel` / `.adv` |
| 图标尺寸兜底（避免内联 SVG 被 flex 撑开） | `STYLE` 顶部 `svg { width:14px; ... }` |
| 静态预览跟随系统深浅色 | `scripts/e2e-settings.js` → `writePreview` |

### v0.3.0 新增（设置页）

| 能力 | 位置 |
| --- | --- |
| 独立设置页面（5 分区 / 搜索 / 脏状态 / 校验横幅） | `src/ui/settingsPanel.ts` |
| 配置分组、扁平化、类型强制、变更对比、健康状态 | `src/infra/config/settingsSchema.ts` |
| 密钥在页面内读写与掩码（仍只进 SecretStorage） | `settingsPanel.ts` → `SecretStore` |
| 页面内获取模型 / 测试连接（用表单当前值，无需先保存） | `settingsPanel.ts` → `ModelStore.fetch` / `pingModel` |
| 工作区级覆盖提示 | `settingsPanel.ts` → `cfg.inspect().workspaceValue` |
| 原生入口保留 | `commitCraft.openNativeSettings` |

## 三、计划外的实现取舍

这些地方与计划文字有出入，是刻意调整：

1. **规则里的"预览确认"没用 Webview，改用 `showInputBox` 预填**。可直接编辑、能拿到用户改后的值、少一个 Webview 生命周期问题。由 `commitCraft.commit.confirmBeforeInsert` 控制。
2. **不用各厂商 SDK，手写 4 个适配器**。产物因此只有 167 KB（构建后），无原生依赖，Ollama 的 NDJSON 也能自己处理。
3. **Token 估算用启发式而非 tiktoken**。tiktoken 带 WASM/原生依赖，会让包体和跨平台打包变复杂；当前只用于"是否超预算"的判断。
4. **截断策略是"先丢文件，再截单文件"**，不是按 hunk 均分。
5. **审查问题的行号越界一律降级为文件级**，不打波浪线。宁可少标，不可标错行。
6. **模型列表缓存放 globalState 而不是 settings.json**。它是可再生的探测结果，写进设置会污染用户配置并随 Settings Sync 扩散。
7. **`model` 留空时回填推荐默认值而不是报错**。新用户最常见的失败是"不知道为什么用不了"，回填 + 提示比拦住他更有用；只有 Azure（没有默认 deployment）才仍然要求必填。兜底值按"识别到的入口"取（DeepSeek 地址 → deepseek-chat），而不是只看协议类型。
8. **审查结果存 workspaceState 而不是只放内存**。Webview 关掉就丢结果，是"没地方看"的根因；落盘后侧边栏、状态栏、报告都读同一份数据，重载窗口仍在。
9. **不引入 TreeView 的 `getParent` / 增量刷新**。一次审查最多 30 条问题，全量 `fire(undefined)` 足够，代码少一半。

## 四、验证方式与实测结果

```bash
npm run compile   # tsc --noEmit，0 错误
npm run test      # 127 项（含 6 项真实 git 仓库集成测试）全绿
npm run smoke     # 桩环境激活：19 命令注册成功，27 个可释放资源
npm run e2e       # 三条端到端链路
npm run package   # 产出 commit-craft-0.2.0.vsix
```

端到端验证覆盖的真实链路：

- **生成**：临时 git 仓库 → `git add` → 生成命令 → 断言请求 URL / `Authorization` / 请求体内含真实 diff、不含被排除的 lockfile、含最近提交 → 断言输入框内容与模型输出一致 → 断言草稿可恢复为用户原值。
- **审查**：模型返回 3 条问题（1 条合法行号 / 1 条落在未修改行 / 1 条指向不存在的文件）→ 断言只有第一条进诊断、`startLine` 正确（0-based 3）、报告不含臆造问题、有降级说明 → **断言结果已写入 workspaceState、侧边栏按文件分组且首条为高危、关掉面板后能重新打开、复制的 Markdown 含标题与行号、清空后存储与诊断同时被清**。
- **模型获取**：向导选 DeepSeek → 断言写入 provider/baseUrl/model 与密钥 → 断言按新地址和密钥请求 `/models` 且缓存落盘 → 换地址再选模型断言自动请求 1 次 → 同地址再选断言 0 次请求（命中缓存）→ 关闭 `autoFetchModels` 后断言 0 次请求且仍有手动入口。

## 五、下一步建议（按性价比排序）

1. **接一次真模型做人工走查**（30 分钟）：`npm run package` 装本机，用 DeepSeek 或 Ollama 跑 3 个真实提交，看提示词效果与格式命中率。
2. **F17 快速修复**：把 `suggestion` 做成 Code Action + `WorkspaceEdit`，应用前 diff 预览。这是当前体验增量最大的一项（侧边栏已为此留好 `contextValue = commitCraft.issue.<severity>`）。
3. **审查结果落盘文件**：可选写到 `.git/commitcraft-review.md`，方便附到 MR。
4. **F15 i18n**：文案抽到 `l10n/bundle.l10n.zh-cn.json`，代码里换 `vscode.l10n.t()`。
5. **发布准备**：`publisher` 改成你自己的 Marketplace 发布者名，`vsce login` 后 `vsce publish --pre-release` 灰度。

## 六、发布状态（2026-10-26）

发布流程已按计划 §6 代码化为 `scripts/publish.js`，`npm run preflight / release:dry / release:pre / release` 分别对应「检查 / 演练 / 灰度 / 正式」。

### 已就绪

| 项目 | 结果 |
| --- | --- |
| §6.2 检查清单 | 13 项自动核对，全部为 ✓（2 个提醒项：`repository` 空、`onStartupFinished`） |
| 工具链 | `@vscode/vsce 4.0.0` + `ovsx 1.3.0`，`npm run package` 走 `vscode:prepublish` 出生产包 |
| 版本基线 | **0.4.1**，`package.json` / `CHANGELOG.md` / git tag `v0.4.1` 三处一致 |
| 类型基线 | `@types/vscode` 锁 `1.90.0` = `engines.vscode` 最低版，`tsc` 0 错误（证明没有偷偷用新 API） |
| 包内容 | 17 文件 / 132 KB：`dist/extension.js` 181 KB + `media/`（图标 + 8 个服务商 SVG），无源码/测试/sourcemap |
| 本地安装走查 | `code --install-extension commit-craft-0.4.1.vsix --force` 成功，版本与 `galleryBanner` 均正确 |

### 待你操作（外部账号依赖，无法代做）

1. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建发布者，ID 必须与 `package.json` 的 `publisher`（当前 `miaosha-ikio`）一致。
2. 在 [Azure DevOps](https://dev.azure.com) 生成 PAT，Scope 勾 **Marketplace → Manage**（Organization 选 All accessible）。
3. 提供令牌后执行：`VSCE_PAT=xxx npm run release`（先灰度用 `npm run release:pre`）。
4. 可选：`OVSX_PAT` 同步 Open VSX；补 `repository`/`bugs` 让 Marketplace 页面出现源码与 Issue 入口。

