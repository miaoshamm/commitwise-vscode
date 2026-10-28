import * as vscode from 'vscode';
import { TemplateRegistry } from '../domain/prompt/builtinTemplates';
import { AppDeps } from '../app/context';
import { pingModel } from '../infra/ai/callModel';
import { ModelInfo } from '../infra/ai/modelCatalog';
import { AiError } from '../infra/ai/types';
import {
  applyValues,
  changedKeys,
  describeHealth,
  flattenRaw,
  maskSecret,
  SECTION,
  SETTINGS_SECTIONS,
} from '../infra/config/settingsSchema';
import { readRawConfig, CONFIG_SECTION } from '../infra/config/configService';
import { validateConfig } from '../infra/config/configTypes';
import {
  detectConfigMismatch,
  ENDPOINT_PRESETS,
  matchEndpointPreset,
  presetOf,
} from '../infra/config/providerPresets';
import { PROVIDER_IDS, PROVIDER_LABELS, ProviderId } from '../infra/config/providers';
import { loadProviderIcons, PROVIDER_TYPE_ICON } from './providerIcons';

/** 编辑器的设置作用域：设置页统一写全局，避免「工作区里改了却以为全局生效」 */
const TARGET = vscode.ConfigurationTarget.Global;

const VIEW_TYPE = 'commitCraft.settings';

interface KeyState {
  hasKey: boolean;
  masked?: string;
  envName: string;
  envPresent: boolean;
}

interface PanelState {
  schema: unknown;
  values: Record<string, unknown>;
  defaults: Record<string, unknown>;
  health: ReturnType<typeof describeHealth>;
  meta: Record<string, unknown>;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/**
 * 独立的设置页面。
 *
 * 为什么不用原生设置：25 个配置项平铺在设置页里，用户看到的是 `commitCraft.diff.excludeGlobs`
 * 这种键名和一句简短的 description，既不知道「改了会怎样」，也不知道「推荐填什么」。
 * 这里按「模型 / 提交信息 / 审查 / 上下文 / 高级」重新分组，并提供原生做不到的三件事：
 * 服务商一键填充、密钥状态可视、保存前即时校验。
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private fetchController: AbortController | undefined;
  /** webview 还没 ready 时先记住要打开的分区，等 ready 后再补发 */
  private pendingSection: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: AppDeps,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.panel.webview.html = this.renderHtml();

    this.panel.webview.onDidReceiveMessage(
      // 返回 Promise 而不是 void：宿主不在意，但端到端脚本可以 await 到处理完成
      (msg) => this.onMessage(msg),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // 外部（settings.json / 其他命令）改动配置时同步进来，避免两边值不一致
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) {
          void this.pushState('configChanged');
        }
      }),
    );
  }

  static show(context: vscode.ExtensionContext, deps: AppDeps, section?: string): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (section) {
        void SettingsPanel.current.panel.webview.postMessage({ type: 'focusSection', section });
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'CommitCraft 设置', vscode.ViewColumn.Active, {
      enableScripts: true,
      // 切走再切回来不重建，表单里没保存的改动不会丢
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    const created = new SettingsPanel(panel, deps, context);
    SettingsPanel.current = created;
    if (section) {
      created.pendingSection = section;
    }
  }

  static disposeAll(): void {
    SettingsPanel.current?.panel.dispose();
  }

  private dispose(): void {
    SettingsPanel.current = undefined;
    this.fetchController?.abort();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  // ---------------------------------------------------------------- 状态组装

  private async keyState(raw = readRawConfig(), provider = raw.provider): Promise<KeyState> {
    const stored = await this.deps.secrets.get(provider);
    return {
      hasKey: !stored ? false : Boolean(stored),
      masked: maskSecret(stored),
      envName: raw.apiKeyEnv,
      envPresent: Boolean(raw.apiKeyEnv && process.env[raw.apiKeyEnv]?.trim()),
    };
  }

  private templateOptions(): Record<string, Array<{ value: string; label: string; description?: string }>> {
    const raw = readRawConfig();
    const registry = new TemplateRegistry({ customTemplates: raw.customTemplates });
    const toOption = (type: 'commit' | 'review') =>
      registry.list(type).map((t) => ({
        value: t.id,
        label: `${t.name}${t.builtin ? '' : '（自定义）'}`,
        description: t.description,
      }));
    return { commitTemplates: toOption('commit'), reviewTemplates: toOption('review') };
  }

  private async buildState(): Promise<PanelState> {
    const raw = readRawConfig();
    const keys = await this.keyState(raw);
    const apiKey = await this.deps.secrets.resolve(raw.provider, raw.apiKeyEnv);
    const validation = validateConfig(raw, vscode.env.language, apiKey);
    const preset = presetOf(raw.provider);

    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const values = flattenRaw(raw);
    const defaults: Record<string, unknown> = {};
    const overridden: string[] = [];
    for (const key of Object.keys(values)) {
      const short = key.replace(`${SECTION}.`, '');
      const inspected = cfg.inspect(short);
      if (inspected) {
        defaults[key] = inspected.defaultValue;
        // 本页统一写全局；工作区级的值优先级更高，会盖掉页面上的修改，必须告诉用户
        if (inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined) {
          overridden.push(short);
        }
      }
    }

    const active = matchEndpointPreset(raw.provider, raw.baseUrl);
    const cached = this.deps.models.get(raw.provider, raw.baseUrl) ?? [];
    // 认出了具体入口（DeepSeek / 百炼…）就用它的名字与推荐模型，否则退回协议层的通用默认值
    const effectiveDefaultModel = active?.defaultModel || preset.defaultModel;
    const effectiveLabel = active?.label || PROVIDER_LABELS[raw.provider as ProviderId] || raw.provider;

    const providerDefaults: Record<string, unknown> = {};
    for (const id of PROVIDER_IDS) {
      const p = presetOf(id);
      providerDefaults[id] = {
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        requiresApiKey: p.requiresApiKey,
        supportsModelList: p.supportsModelList,
        modelHint: p.modelHint,
        urlHint: p.urlHint,
      };
    }

    return {
      schema: {
        sections: SETTINGS_SECTIONS,
        templates: this.templateOptions(),
        providers: PROVIDER_IDS.map((id) => ({ id, label: PROVIDER_LABELS[id] })),
        presets: ENDPOINT_PRESETS,
        providerDefaults,
      },
      values,
      defaults,
      health: describeHealth({
        errors: validation.errors,
        warnings: validation.warnings,
        provider: raw.provider,
        model: (raw.model ?? '').trim() || effectiveDefaultModel || '(未设置)',
        hasKey: keys.hasKey || Boolean(apiKey),
        requiresKey: preset.requiresApiKey,
        envName: raw.apiKeyEnv,
        envPresent: keys.envPresent,
      }),
      meta: {
        provider: raw.provider,
        providerLabel: effectiveLabel,
        providerTypeLabel: PROVIDER_LABELS[raw.provider as ProviderId] ?? raw.provider,
        requiresKey: preset.requiresApiKey,
        supportsModelList: preset.supportsModelList,
        modelHint: preset.modelHint,
        urlHint: preset.urlHint,
        defaultModel: effectiveDefaultModel,
        activePresetKey: active?.key ?? '',
        activeKeyHint: active?.keyHint ?? '',
        mismatch: detectConfigMismatch(raw.provider, raw.baseUrl) ?? '',
        key: keys,
        models: cached,
        modelsFetchedAt: this.deps.models.fetchedAt,
        workspaceOverrides: overridden,
        errors: validation.errors,
        warnings: validation.warnings,
        modelDefaulted: validation.modelDefaulted ?? '',
      },
    };
  }

  private async pushState(type: 'state' | 'configChanged', extra: Record<string, unknown> = {}): Promise<void> {
    const state = await this.buildState();
    void this.panel.webview.postMessage({ type, state, ...extra });
  }

  // ---------------------------------------------------------------- 消息处理

  private async onMessage(msg: any): Promise<void> {
    const type = msg?.type;
    try {
      switch (type) {
        case 'ready':
          await this.pushState('state');
          if (this.pendingSection) {
            void this.panel.webview.postMessage({ type: 'focusSection', section: this.pendingSection });
            this.pendingSection = undefined;
          }
          return;
        case 'save':
          await this.save(msg.values ?? {});
          return;
        case 'resetSection':
          await this.resetSection(msg.section, msg.keys ?? []);
          return;
        case 'dirtyChanged':
          // dirty 状态同步到标题：● 与编辑器未保存文件同款语言，关页前最后一眼能看到
          this.panel.title = msg.dirty > 0 ? '● CommitCraft 设置' : 'CommitCraft 设置';
          return;
        case 'saveKey':
          await this.saveKey(msg.provider, msg.key);
          return;
        case 'clearKey':
          await this.clearKey(msg.provider);
          return;
        case 'queryKey':
          // 切换服务商时刷新密钥状态：密钥是按服务商分别存的
          void this.panel.webview.postMessage({
            type: 'keyState',
            provider: msg.provider,
            key: await this.keyState(undefined, msg.provider),
          });
          return;
        case 'fetchModels':
          await this.fetchModels(msg);
          return;
        case 'test':
          await this.testConnection(msg);
          return;
        case 'openNative':
          await vscode.commands.executeCommand('commitCraft.openNativeSettings');
          return;
        case 'openOutput':
          this.deps.logger.show();
          return;
        default:
          return;
      }
    } catch (err) {
      const message = err instanceof AiError ? err.toUserMessage() : ((err as Error)?.message ?? String(err));
      this.deps.logger.error(`设置页操作失败（${type}）：${message}`, err);
      void this.panel.webview.postMessage({ type: 'toast', level: 'error', message });
    }
  }

  private async save(values: Record<string, unknown>): Promise<void> {
    const current = readRawConfig();
    const before = flattenRaw(current);
    const next = applyValues(current, values);
    const after = flattenRaw(next);
    const keys = changedKeys(before, after).filter((k) => after[k] !== undefined || before[k] !== undefined);

    // 落盘前先校验：宁可拒绝写入，也不要把一份跑不起来的配置存进 settings.json
    const apiKey = await this.deps.secrets.resolve(next.provider, next.apiKeyEnv);
    const validation = validateConfig(next, vscode.env.language, apiKey);
    if (validation.errors.length > 0) {
      void this.panel.webview.postMessage({
        type: 'saveFailed',
        errors: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    if (keys.length > 0) {
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
      for (const fullKey of keys) {
        await cfg.update(fullKey.replace(`${SECTION}.`, ''), after[fullKey], TARGET);
      }
      this.deps.logger.info(`设置页已保存 ${keys.length} 项：${keys.map((k) => k.replace(`${SECTION}.`, '')).join(', ')}`);
    }

    const state = await this.buildState();
    void this.panel.webview.postMessage({
      type: 'saved',
      state,
      changed: keys.length,
      warnings: validation.warnings,
    });
    this.deps.statusBar.idle();
  }

  private async resetSection(section: string, keys: string[]): Promise<void> {
    const label = SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? section;
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);

    // 恢复是立即落盘的操作：先记录全局层旧值，确认后执行，并支持一键撤销
    const undoEntries: Array<[string, unknown]> = [];
    for (const key of keys) {
      const short = String(key).replace(`${SECTION}.`, '');
      const inspected = cfg.inspect(short);
      if (!inspected) {
        continue;
      }
      undoEntries.push([short, inspected.globalValue]);
    }
    if (undoEntries.length === 0) {
      void this.panel.webview.postMessage({ type: 'toast', level: 'warn', message: '当前分区没有可恢复的设置项' });
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `将把「${label}」分区的 ${undoEntries.length} 项设置恢复为默认值，立即写入全局配置。`,
      { modal: true },
      '恢复默认',
    );
    if (confirm !== '恢复默认') {
      void this.panel.webview.postMessage({ type: 'toast', level: 'warn', message: '已取消，没有修改任何设置' });
      return;
    }

    let count = 0;
    for (const [short] of undoEntries) {
      const inspected = cfg.inspect(short);
      if (!inspected) {
        continue;
      }
      await cfg.update(short, inspected.defaultValue, TARGET);
      count++;
    }
    this.deps.logger.info(`设置页恢复默认：${section} 共 ${count} 项`);
    const state = await this.buildState();
    void this.panel.webview.postMessage({ type: 'saved', state, changed: count, resetSection: section });

    const undo = await vscode.window.showInformationMessage(`已恢复「${label}」分区默认值。`, '撤销恢复');
    if (undo === '撤销恢复') {
      for (const [short, value] of undoEntries) {
        await cfg.update(short, value, TARGET);
      }
      this.deps.logger.info(`已撤销「${label}」分区的恢复操作`);
      const restored = await this.buildState();
      void this.panel.webview.postMessage({ type: 'saved', state: restored, changed: undoEntries.length, resetSection: section, undo: true });
    }
  }

  private async saveKey(provider: string, key: string): Promise<void> {
    const value = String(key ?? '').trim();
    if (!value) {
      void this.panel.webview.postMessage({ type: 'toast', level: 'warn', message: '密钥为空，未保存' });
      return;
    }
    if (value.length < 8) {
      void this.panel.webview.postMessage({ type: 'toast', level: 'warn', message: '密钥长度看起来不对（少于 8 位）' });
      return;
    }
    await this.deps.secrets.set(provider, value);
    this.deps.logger.info(`设置页已保存 ${provider} 的密钥（长度 ${value.length}）`);
    const raw = readRawConfig();
    void this.panel.webview.postMessage({ type: 'keyState', provider, key: await this.keyState(raw) });
    void this.panel.webview.postMessage({ type: 'toast', level: 'ok', message: '密钥已保存到凭据库' });
    // 密钥变了，健康状态和模型列表都要重算
    await this.pushState('configChanged');
    this.deps.statusBar.idle();
  }

  private async clearKey(provider: string): Promise<void> {
    await this.deps.secrets.clear(provider);
    this.deps.logger.info(`设置页已清除 ${provider} 的密钥`);
    void this.panel.webview.postMessage({ type: 'keyState', provider, key: await this.keyState(readRawConfig()) });
    void this.panel.webview.postMessage({ type: 'toast', level: 'ok', message: '密钥已清除' });
    await this.pushState('configChanged');
  }

  private async fetchModels(msg: {
    provider: string;
    baseUrl: string;
    key?: string;
  }): Promise<void> {
    this.fetchController?.abort();
    const controller = new AbortController();
    this.fetchController = controller;
    const raw = readRawConfig();
    const apiKey = String(msg.key ?? '').trim() || (await this.deps.secrets.resolve(msg.provider, raw.apiKeyEnv));

    void this.panel.webview.postMessage({ type: 'modelsLoading' });
    try {
      const models = await this.deps.models.fetch({
        provider: msg.provider,
        baseUrl: msg.baseUrl,
        apiKey,
        timeoutMs: 20000,
        signal: controller.signal,
      });
      this.deps.logger.info(`设置页获取模型列表：${models.length} 个`);
      void this.panel.webview.postMessage({
        type: 'models',
        models,
        fetchedAt: this.deps.models.fetchedAt,
      });
    } catch (err) {
      const message = err instanceof AiError ? err.toUserMessage() : ((err as Error)?.message ?? String(err));
      this.deps.logger.warn(`设置页获取模型列表失败：${message}`);
      void this.panel.webview.postMessage({ type: 'models', models: [] as ModelInfo[], error: message });
    } finally {
      if (this.fetchController === controller) {
        this.fetchController = undefined;
      }
    }
  }

  private async testConnection(msg: {
    values: Record<string, unknown>;
    key?: string;
  }): Promise<void> {
    const raw = applyValues(readRawConfig(), msg.values ?? {});
    const apiKey = String(msg.key ?? '').trim() || (await this.deps.secrets.resolve(raw.provider, raw.apiKeyEnv));
    const validation = validateConfig(raw, vscode.env.language, apiKey);
    if (!validation.config) {
      void this.panel.webview.postMessage({
        type: 'testResult',
        ok: false,
        message: validation.errors[0] ?? '配置不完整',
      });
      return;
    }

    void this.panel.webview.postMessage({ type: 'testRunning' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(validation.config.requestTimeoutMs, 45000));
    try {
      const result = await pingModel(validation.config, controller.signal);
      this.deps.logger.info(`设置页连接测试成功：${result.ms}ms`);
      void this.panel.webview.postMessage({
        type: 'testResult',
        ok: true,
        message: `连接成功 · ${result.ms}ms · ${validation.config.model}${result.sample ? ` · 响应「${result.sample}」` : ''}`,
      });
    } catch (err) {
      const message = err instanceof AiError ? err.toUserMessage() : ((err as Error)?.message ?? String(err));
      this.deps.logger.warn(`设置页连接测试失败：${message}`);
      void this.panel.webview.postMessage({ type: 'testResult', ok: false, message });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- HTML

  private renderHtml(): string {
    const nonce = getNonce();
    const webview = this.panel.webview;
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png'));
    // 图标以字符串形式注入脚本（内联 SVG 才能跟随 currentColor），只在创建面板时读一次磁盘
    const icons = loadProviderIcons(this.context.extensionUri.fsPath);
    // 用函数式替换：字符串替换里 $& 之类的序列会被当成特殊模式，SVG 内容不该被二次解释
    const script = SCRIPT.replace('__PROV_ICONS__', () => JSON.stringify(icons)).replace('__TYPE_ICON__', () =>
      JSON.stringify(PROVIDER_TYPE_ICON),
    );
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CommitCraft 设置</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <img class="logo" src="${logo}" alt="">
    <div class="titles">
      <div class="title">CommitCraft<span class="title-sep">/</span><span class="title-sub">设置</span></div>
      <div class="subtitle" id="subtitle">正在加载…</div>
    </div>
    <div class="search">
      <span class="search-ico">${ICON_SEARCH}</span>
      <input id="search" type="search" placeholder="搜索设置项，例如 密钥 / 超时 / glob" spellcheck="false">
    </div>
    <button class="icon-btn" id="btn-native" title="在原生设置界面打开（可直接编辑 settings.json）">${ICON_JSON}<span>settings.json</span></button>
  </header>

  <div class="health" id="health" hidden></div>

  <div class="main">
    <nav class="nav" id="nav"></nav>
    <div class="content" id="content"></div>
  </div>

  <footer class="footer">
    <button class="ghost small" id="btn-reset" title="把当前分区的设置恢复为默认值（有确认，可撤销）">恢复当前分区默认</button>
    <div class="spacer"></div>
    <span class="dirty" id="dirty"></span>
    <button class="primary" id="btn-save" disabled>${ICON_SAVE}<span>保存</span></button>
  </footer>

  <div class="toasts" id="toasts"></div>
</div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }
}

/* ------------------------------------------------------------------ 样式 */

const STYLE = `
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
/*
 * 所有内联图标的兜底尺寸。
 * 之前只给「按钮里的 svg」写了尺寸，密钥区标题里的钥匙图标没有任何约束，
 * 而 <svg> 在 flex 容器里会按容器撑开，于是渲染出一个巨大的图标——
 * 页面上「图片大小异常」就是这么来的。这里统一兜底，再让各组件按需覆盖。
 */
svg { width: 14px; height: 14px; flex: none; }
.app { display: flex; flex-direction: column; height: 100vh; }

/* 顶栏 */
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 18px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
  background: var(--vscode-sideBar-background, transparent);
  flex: none;
}
.logo { width: 24px; height: 24px; border-radius: 6px; flex: none; }
.titles { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.title { font-size: 13.5px; font-weight: 600; letter-spacing: .2px; display: flex; align-items: baseline; gap: 5px; }
.title-sep { color: var(--vscode-descriptionForeground); font-weight: 400; }
.title-sub { font-weight: 500; color: var(--vscode-descriptionForeground); }
.subtitle {
  font-size: 11.5px; color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.search { margin-left: auto; position: relative; display: flex; align-items: center; }
.search-ico {
  position: absolute; left: 8px; display: flex;
  color: var(--vscode-descriptionForeground); pointer-events: none;
}
.search-ico svg { width: 13px; height: 13px; }
.search input {
  width: 244px; height: 28px; padding: 0 9px 0 27px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 6px; outline: none; font-size: 12.5px;
}
.search input:focus { border-color: var(--vscode-focusBorder); }
.icon-btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 10px;
  font-size: 12px; font-family: inherit; cursor: pointer; flex: none;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  border-radius: 6px;
}
.icon-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.14)); }
.icon-btn svg { width: 13px; height: 13px; }

/* 健康横幅 */
.health {
  flex: none; display: flex; gap: 9px; align-items: flex-start;
  padding: 9px 18px; font-size: 12.5px; line-height: 1.5;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18));
}
.health .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 6px; flex: none; }
.health.ok .dot { background: var(--vscode-testing-iconPassed, #3fb950); }
.health.warn .dot { background: var(--vscode-editorWarning-foreground, #d29922); }
.health.error .dot { background: var(--vscode-editorError-foreground, #f85149); }
.health .h-title { font-weight: 600; }
.health .h-detail { color: var(--vscode-descriptionForeground); }

/* 主体 */
.main { flex: 1; display: flex; min-height: 0; }
.nav {
  width: 190px; flex: none; padding: 10px 8px; overflow-y: auto;
  border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18));
  background: var(--vscode-sideBar-background, transparent);
}
.nav-item {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; margin-bottom: 2px; border-radius: 6px;
  font-size: 12.8px; color: var(--vscode-foreground);
  cursor: pointer; border: none; background: transparent; width: 100%; text-align: left;
  font-family: inherit;
}
.nav-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
.nav-item.active {
  background: var(--vscode-list-activeSelectionBackground, rgba(0,120,215,.28));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  font-weight: 600;
}
.nav-item svg { width: 15px; height: 15px; opacity: .85; }
.nav-item .count {
  margin-left: auto; font-size: 10.5px; padding: 1px 6px; border-radius: 9px;
  background: var(--vscode-badge-background, rgba(128,128,128,.28));
  color: var(--vscode-badge-foreground, inherit);
  font-weight: 500;
}

.content { flex: 1; overflow-y: auto; padding: 20px 24px 32px; min-width: 0; }
/* 面板很宽时别让说明文字拉成一行长条，读起来累 */
.page { max-width: 900px; }

/* 分区标题（带步骤序号） */
.sec-head { margin: 0 0 10px; }
.sec-head + .sec-head { margin-top: 0; }
.sec-head h2 { margin: 0; font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.sec-head p { margin: 5px 0 0; font-size: 11.8px; line-height: 1.55; color: var(--vscode-descriptionForeground); }
.sec-head.has-step p { margin-left: 26px; }
.step {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10.5px; font-weight: 600;
  background: var(--vscode-badge-background, rgba(128,128,128,.28));
  color: var(--vscode-badge-foreground, inherit);
}
.sec-gap { height: 22px; }

/* 通用行 */
.row {
  display: grid; grid-template-columns: minmax(0,1fr) 288px;
  gap: 8px 18px; align-items: start;
  padding: 9px 10px; border-radius: 6px;
}
.row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.06)); }
.row.wide { grid-template-columns: minmax(0,1fr); }
.row.invalid { background: var(--vscode-inputValidation-errorBackground, rgba(248,81,73,.1)); }
.row-label { font-size: 12.6px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.row-label svg { width: 13px; height: 13px; opacity: .8; }
.row-desc { font-size: 11.5px; color: var(--vscode-descriptionForeground); line-height: 1.55; margin-top: 3px; }
.row-caution { font-size: 11.5px; color: var(--vscode-editorWarning-foreground, #d29922); margin-top: 4px; }
.row-control { display: flex; align-items: center; gap: 7px; justify-content: flex-end; }
.row.wide .row-control { justify-content: flex-start; }
.badge-mod {
  font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: 500;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background, rgba(128,128,128,.24));
}
.revert {
  border: none; background: transparent; cursor: pointer; padding: 3px;
  color: var(--vscode-descriptionForeground); border-radius: 4px; line-height: 0; flex: none;
}
.revert:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
.revert svg { width: 12px; height: 12px; }

/* 模型选择：输入框 + 可点击展开的列表。
   <input list=...> + <datalist> 在 webview 里没有箭头、要打字才提示，
   用户根本不知道能选，所以这里自绘一个 combobox。 */
.combo { position: relative; flex: 1 1 240px; max-width: 360px; min-width: 0; display: flex; }
.combo input[type=text] { padding-right: 30px; }
.combo-toggle {
  position: absolute; right: 1px; top: 1px; bottom: 1px; width: 26px; padding: 0;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  border: none; border-radius: 0 5px 5px 0; background: transparent;
  color: var(--vscode-descriptionForeground);
}
.combo-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
.combo-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.combo-toggle svg { width: 11px; height: 11px; }
.combo.is-open .combo-toggle { color: var(--vscode-foreground); }
.combo-pop {
  position: absolute; z-index: 30; left: 0; right: 0; top: calc(100% + 4px);
  max-height: 236px; overflow-y: auto; padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526));
  box-shadow: 0 8px 22px rgba(0,0,0,.26);
}
.combo-pop[hidden] { display: none; }
.combo-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: none; border-radius: 5px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.combo-item:hover, .combo-item.active { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.16)); }
.combo-item.on { background: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,.35)); color: var(--vscode-list-activeSelectionForeground, inherit); }
.combo-item[hidden] { display: none; }
.ci-name {
  flex: 1; min-width: 0; font-size: 12.3px;
  font-family: var(--vscode-editor-font-family, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ci-note { font-size: 10.5px; opacity: .7; flex: none; }
.ci-check { width: 12px; height: 12px; flex: none; display: flex; }
.ci-check svg { width: 12px; height: 12px; }
.combo-empty { padding: 8px 9px; font-size: 11.5px; line-height: 1.5; color: var(--vscode-descriptionForeground); }

input[type=text], input[type=password], input[type=search], select, textarea {
  font-family: inherit; font-size: 12.5px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 6px; outline: none;
}
input[type=text], input[type=password], select { height: 28px; padding: 0 8px; }
input[type=text] { width: 100%; }
input[type=number] {
  width: 92px; height: 28px; padding: 0 8px; text-align: right;
  font-family: inherit; font-size: 12.5px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 6px; outline: none;
}
select {
  min-width: 0; cursor: pointer;
  /* 原生下拉箭头在各平台差异极大（Windows 是个方块，macOS 是细箭头），
     统一去掉自绘，同一套箭头、同一套内外边距，才能和输入框对齐 */
  appearance: none; -webkit-appearance: none;
  padding: 0 26px 0 9px; line-height: 26px;
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  border-color: var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,.35)));
  text-overflow: ellipsis;
}
select option {
  background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, #252526));
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
}
/* 自绘箭头：包一层定位，箭头用 currentColor，深浅主题都跟色 */
.select-wrap { position: relative; display: inline-flex; align-items: center; min-width: 0; }
.select-wrap select { width: 100%; }
.select-wrap .caret {
  position: absolute; right: 8px; width: 10px; height: 10px; flex: none;
  pointer-events: none; opacity: .75;
  color: var(--vscode-dropdown-foreground, var(--vscode-descriptionForeground));
}
/* 宽度统一按最长的一档标签留：模板名如「Conventional Commits（简洁）」不再被截成省略号 */
.row-control .select-wrap { width: 232px; max-width: 100%; }
.row-control .select-wrap.wide-select { width: 100%; }
textarea {
  width: 100%; min-height: 66px; padding: 7px 9px; resize: vertical;
  line-height: 1.55; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
}
input:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
input.invalid, textarea.invalid { border-color: var(--vscode-inputValidation-errorBorder, #f85149); }
.suffix { font-size: 11.5px; color: var(--vscode-descriptionForeground); flex: none; }

/* 开关 */
.switch { position: relative; display: inline-block; width: 34px; height: 18px; flex: none; cursor: pointer; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .track {
  position: absolute; inset: 0; border-radius: 9px; transition: background .15s;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.45));
}
.switch .thumb {
  position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--vscode-descriptionForeground); transition: transform .15s, background .15s;
}
.switch input:checked + .track { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
.switch input:checked + .track + .thumb { transform: translateX(16px); background: var(--vscode-button-foreground, #fff); }
.switch input:focus-visible + .track { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

/* 面板：把一组相关设置收进一个带边框的卡片 */
.panel {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
  border-radius: 8px;
  /* 不能 hidden：模型下拉是绝对定位浮层，会被裁掉。
     行本身没有底色，所以放开也不会溢出圆角。 */
  overflow: visible;
  background: var(--vscode-editorWidget-background, transparent);
}
.panel > * + * { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.16)); }
.panel .row { border-radius: 0; padding: 13px 14px; }
.panel .row:hover { background: transparent; }
.panel .row.wide .row-control { margin-top: 8px; }

/* 服务商选择：等高等宽，图标 + 标题 + 一行说明 */
.picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 8px; }
.card {
  display: flex; align-items: center; gap: 9px;
  height: 54px; padding: 0 11px; min-width: 0;
  text-align: left; font-family: inherit; cursor: pointer;
  border-radius: 8px;
  background: var(--vscode-editorWidget-background, transparent);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
  color: var(--vscode-foreground);
  transition: border-color .12s, background .12s;
}
.card:hover { border-color: var(--vscode-focusBorder); }
.card.active {
  border-color: var(--vscode-button-background);
  box-shadow: inset 0 0 0 1px var(--vscode-button-background);
}
/* 图标底色固定用半透明灰，浅色/深色主题都有对比度（用 input-background 会在浅色下糊成一片） */
.c-ico {
  width: 28px; height: 28px; border-radius: 7px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: rgba(128,128,128,.16);
  color: var(--vscode-foreground);
}
.c-ico svg { width: 17px; height: 17px; }
.card.active .c-ico { background: var(--vscode-button-background); color: var(--vscode-button-foreground, #fff); }
.c-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.c-name {
  font-size: 12.4px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.c-desc {
  font-size: 10.8px; color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.c-check { display: none; flex: none; color: var(--vscode-button-background); }
.card.active .c-check { display: flex; }
.c-check svg { width: 13px; height: 13px; }

/* 密钥块 */
.keybox { padding: 13px 14px; }
.k-head { display: flex; align-items: center; gap: 7px; margin-bottom: 9px; font-size: 12.6px; font-weight: 500; }
.k-head > svg { width: 14px; height: 14px; opacity: .8; }
.k-state { margin-left: auto; font-size: 11.4px; color: var(--vscode-descriptionForeground); font-weight: 400; }
.k-state.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.k-state.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
.keybox .k-row { display: flex; gap: 8px; }
.keybox .k-row input { flex: 1; min-width: 0; }
.k-hint { margin-top: 8px; font-size: 11.4px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
.k-warn { margin-top: 8px; font-size: 11.4px; color: var(--vscode-editorWarning-foreground, #d29922); }

/* 按钮 */
button.primary, button.ghost, button.mini {
  font-family: inherit; font-size: 12.5px; cursor: pointer; border-radius: 6px;
  border: 1px solid transparent; height: 28px; padding: 0 13px;
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
}
button.primary {
  color: var(--vscode-button-foreground); background: var(--vscode-button-background);
}
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.primary:disabled { opacity: .45; cursor: default; }
button.ghost {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground, transparent);
  border-color: var(--vscode-panel-border, rgba(128,128,128,.35));
}
button.ghost:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.18)); }
button.ghost:disabled { opacity: .45; cursor: default; }
button.small { height: 25px; padding: 0 10px; font-size: 11.8px; }
button.mini { height: 25px; padding: 0 9px; font-size: 11.5px;
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground, transparent);
  border-color: var(--vscode-panel-border, rgba(128,128,128,.35)); }
button.mini:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.18)); }
button svg { width: 13px; height: 13px; }
.spin { display: inline-block; width: 11px; height: 11px; border-radius: 50%;
  border: 1.5px solid currentColor; border-right-color: transparent;
  animation: sp .7s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }

/* 测试区 */
.testbar { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
.test-result { font-size: 12px; line-height: 1.5; min-width: 0; }
.test-result.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.test-result.err { color: var(--vscode-editorError-foreground, #f85149); }
.test-result.run { color: var(--vscode-descriptionForeground); }

/* 折叠的「更多选项」 */
.adv {
  margin-top: 22px; padding-top: 12px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18));
}
.adv > summary {
  list-style: none; cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 7px; padding: 2px 0;
  font-size: 12.4px; font-weight: 600; color: var(--vscode-foreground);
}
.adv > summary::-webkit-details-marker { display: none; }
.adv > summary::before {
  content: ''; width: 0; height: 0; flex: none;
  border-left: 4.5px solid currentColor;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  opacity: .65; transition: transform .12s;
}
.adv[open] > summary::before { transform: rotate(90deg); }
.adv > summary .adv-note { font-weight: 400; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.adv-body { margin-top: 4px; }

/* 底栏 */
.footer {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 10px 18px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
  background: var(--vscode-sideBar-background, transparent);
}
.footer .spacer { flex: 1; }
.dirty { font-size: 11.8px; color: var(--vscode-editorWarning-foreground, #d29922); }

/* toast */
.toasts { position: fixed; right: 16px; bottom: 56px; display: flex; flex-direction: column; gap: 7px; z-index: 20; }
.toast {
  padding: 8px 12px; border-radius: 6px; font-size: 12.2px; max-width: 380px;
  background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
  color: var(--vscode-notifications-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border));
  box-shadow: 0 2px 10px rgba(0,0,0,.28);
  animation: tin .16s ease-out;
}
.toast.ok { border-left: 3px solid var(--vscode-testing-iconPassed, #3fb950); }
.toast.warn { border-left: 3px solid var(--vscode-editorWarning-foreground, #d29922); }
.toast.error { border-left: 3px solid var(--vscode-editorError-foreground, #f85149); }
@keyframes tin { from { opacity: 0; transform: translateY(5px); } }

.empty { padding: 26px 4px; color: var(--vscode-descriptionForeground); font-size: 12.5px; }
.grid-title {
  font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px;
  color: var(--vscode-descriptionForeground); margin: 18px 0 4px 6px;
}
.hint-inline { font-size: 11.5px; color: var(--vscode-editorWarning-foreground, #d29922); margin: 8px 0 0; line-height: 1.55; }
.hint-line { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin: 6px 0 0; line-height: 1.55; }

/* 清除搜索：空态里的内联文字按钮 */
.link-btn {
  background: none; border: none; padding: 0 4px; cursor: pointer;
  font: inherit; color: var(--vscode-textLink-foreground);
  text-decoration: underline;
}
.link-btn:hover { color: var(--vscode-textLink-activeForeground); }

/* 键盘焦点可见性：Tab 巡航时所有交互元素都能看到焦点位置 */
button:focus-visible,
.nav-item:focus-visible,
.card:focus-visible,
.combo-item:focus-visible,
.combo-toggle:focus-visible,
.icon-btn:focus-visible,
.link-btn:focus-visible,
.mini:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

/* 窄面板（侧边栏同列、小窗）：搜索框收缩、settings.json 文字隐藏 */
@media (max-width: 640px) {
  .search { flex: 1 1 140px; min-width: 0; }
  .icon-btn span { display: none; }
  .icon-btn { padding: 0 6px; }
}
@media (max-width: 560px) {
  .row { grid-template-columns: 1fr; gap: 6px; }
  .row-text { min-width: 0; }
}
`;

/* ------------------------------------------------------------------ 前端脚本 */

const SCRIPT = `
const vscode = acquireVsCodeApi();
/** 服务商图标（内联 SVG，才能跟随 currentColor） */
const PROV_ICONS = __PROV_ICONS__;
/** 服务商类型（请求协议）-> 图标 */
const TYPE_ICON = __TYPE_ICON__;
const ICON = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.6 6.2 11.6 12.8 4.9"/></svg>',
  revert: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 8a4.6 4.6 0 1 0 1.4-3.3"/><path d="M3.4 2.9v2.9h2.9"/></svg>',
  save: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h7.2L13 5.8V13H3z"/><path d="M5.6 3v3.4h4.8V3"/><path d="M5.6 13V9.2h4.8V13"/></svg>',
  plug: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3v2.6M9.8 3v2.6"/><path d="M4.6 5.6h6.8v2.2a3.4 3.4 0 0 1-6.8 0z"/><path d="M8 11.4V13.4"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.8v2.9h-2.9"/></svg>',
  key: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.6" cy="10.4" r="2.4"/><path d="M7.4 8.6 12.8 3.2"/><path d="M10.6 3.2h2.2v2.2"/></svg>',
  // 下拉箭头：上/下两态，和下划线输入框、按钮统一成 1.7 的线宽
  chev: '<svg class="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.4 8 10.4 12 6.4"/></svg>',
  chevUp: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.6 8 5.6 12 9.6"/></svg>',
};

let S = null;             // 宿主下发的完整状态
let draft = {};           // 当前编辑值（list 保持原始文本）
let types = {};           // key -> 字段类型
let dirty = new Set();
let active = 'model';
let query = '';
let lastTest = null;      // { ok, message, running }
let models = [];          // 已获取的模型
let modelsError = '';
let modelsLoading = false;
let keyInput = '';
let keyBusy = false;
let advOpen = false;      // 「更多选项」的展开状态（重绘后需要还原）
let modelOpen = false;    // 模型下拉是否展开（重绘后需要还原）
let lastDirtyPosted = -1; // 上次上报给宿主的 dirty 数（标题 ● 标记用）
let dirtyTipShown = false;

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const SECTIONS_ICON = {
  model: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6"/><path d="M6.4 1.6v2M9.6 1.6v2M6.4 12.4v2M9.6 12.4v2M1.6 6.4h2M1.6 9.6h2M12.4 6.4h2M12.4 9.6h2"/></svg>',
  commit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.6"/><path d="M8 1.6v3.8M8 10.6v3.8"/></svg>',
  review: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.2l1.6 1.6L7.2 3.2"/><path d="M3 11l1.6 1.6L7.2 10"/><path d="M9.2 4.8h4M9.2 11.6h4"/></svg>',
  context: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8l5.2 2.4v4.1c0 3-2.2 5-5.2 6-3-1-5.2-3-5.2-6V4.2z"/></svg>',
  advanced: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 4.6h11.2M2.4 8h11.2M2.4 11.4h11.2"/><circle cx="5.6" cy="4.6" r="1.5" fill="var(--vscode-editor-background)"/><circle cx="10.4" cy="8" r="1.5" fill="var(--vscode-editor-background)"/><circle cx="6.6" cy="11.4" r="1.5" fill="var(--vscode-editor-background)"/></svg>',
};

/* ---------------- 工具 ---------------- */

function fieldMap() {
  const map = {};
  for (const sec of S.schema.sections) for (const f of sec.fields) map[f.key] = { field: f, section: sec };
  return map;
}

function optionsFor(field) {
  if (field.optionsFrom) return (S.schema.templates[field.optionsFrom] || []);
  return field.options || [];
}

/** 下拉里能选的东西：接口拉到的列表 + 用户手填的候选模型（去重，接口优先） */
function modelPickerOptions() {
  const out = [];
  const seen = new Set();
  const push = (id, note) => {
    const name = String(id == null ? '' : id).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ id: name, note: note || '' });
  };
  for (const m of models) if (m) push(m.id, m.note);
  for (const line of String(draft['commitCraft.availableModels'] || '').split('\\n')) push(line);
  return out;
}

function toText(field, value) {
  if (field.type === 'list') return Array.isArray(value) ? value.join('\\n') : String(value || '');
  if (field.type === 'boolean') return value ? 'true' : 'false';
  return value == null ? '' : String(value);
}

function fromText(field, text) {
  if (field.type === 'list') return String(text).split('\\n').map(s => s.trim()).filter(Boolean);
  if (field.type === 'number') return text === '' ? null : Number(text);
  if (field.type === 'boolean') return text === 'true';
  return text;
}

function isDirty(key) { return dirty.has(key); }

function fieldInvalid(key) {
  const meta = fieldMap()[key];
  if (!meta) return '';
  const f = meta.field;
  if (f.type === 'number') {
    const raw = draft[key];
    if (raw === '' || raw == null) return '不能为空';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '需要填数字';
    if (f.min != null && n < f.min) return '不能小于 ' + f.min;
    if (f.max != null && n > f.max) return '不能大于 ' + f.max;
    return '';
  }
  // 接口地址即时校验：必须 http/https 且可解析。input 事件里跳过实时红框
  // （用户正在粘贴时不要打断），blur / 保存按钮 disabled 时仍会读这里。
  if (key === 'commitCraft.baseUrl') {
    const v = String(draft[key] || '').trim();
    if (!v) return '接口地址不能为空';
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '必须以 http:// 或 https:// 开头';
    } catch {
      return '不是合法的 URL';
    }
  }
  return '';
}

/* ---------------- 渲染 ---------------- */

function renderNav() {
  const counts = {};
  for (const key of dirty) {
    const meta = fieldMap()[key];
    if (meta) counts[meta.section.id] = (counts[meta.section.id] || 0) + 1;
  }
  $('nav').innerHTML = S.schema.sections.map(sec => {
    const c = counts[sec.id];
    return '<button class="nav-item' + (sec.id === active && !query ? ' active' : '') + '" data-section="' + sec.id + '">'
      + SECTIONS_ICON[sec.icon]
      + '<span>' + esc(sec.label) + '</span>'
      + (c ? '<span class="count">' + c + '</span>' : '')
      + '</button>';
  }).join('');
}

function renderControl(key) {
  const meta = fieldMap()[key];
  const f = meta.field;
  const value = draft[key];
  const bad = fieldInvalid(key);
  const cls = bad ? ' invalid' : '';

  if (f.type === 'boolean') {
    const on = value === 'true';
    return '<label class="switch"><input type="checkbox" data-key="' + key + '"' + (on ? ' checked' : '') + '>'
      + '<span class="track"></span><span class="thumb"></span></label>';
  }
  if (f.type === 'number') {
    return '<input type="number" data-key="' + key + '" aria-label="' + esc(f.label) + '" value="' + esc(value) + '"'
      + (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '')
      + (f.step != null ? ' step="' + f.step + '"' : '')
      + ' title="' + esc(bad) + '" class="' + cls.trim() + '">'
      + (f.suffix ? '<span class="suffix">' + esc(f.suffix) + '</span>' : '');
  }
  if (f.type === 'select') {
    const opts = optionsFor(f);
    const known = opts.some(o => o.value === value);
    return '<span class="select-wrap">'
      + '<select data-key="' + key + '" aria-label="' + esc(f.label) + '">'
      + (known ? '' : '<option value="' + esc(value) + '" selected>' + esc(value || '(未设置)') + '</option>')
      + opts.map(o => '<option value="' + esc(o.value) + '"' + (o.value === value ? ' selected' : '')
          + ' title="' + esc(o.description || '') + '">' + esc(o.label) + '</option>').join('')
      + '</select>' + ICON.chev
      + '</span>';
  }
  if (f.type === 'list') {
    const rows = Math.min(6, Math.max(3, String(value).split('\\n').length));
    return '<textarea data-key="' + key + '" aria-label="' + esc(f.label) + '" rows="' + rows + '" spellcheck="false" placeholder="'
      + esc(f.placeholder || '') + '">' + esc(value) + '</textarea>';
  }
  return '<input type="text" data-key="' + key + '" aria-label="' + esc(f.label) + '" value="' + esc(value) + '" placeholder="'
    + esc(f.placeholder || '') + '" spellcheck="false" class="' + cls.trim() + '">';
}

function renderRow(key) {
  const meta = fieldMap()[key];
  const f = meta.field;
  // 只有「长内容」才独占一行：文本域和接口地址。下拉框留在右列，否则一列里控件左跳右跳，看着散
  const wide = f.type === 'list' || (f.type === 'text' && f.key.indexOf('baseUrl') >= 0);
  const bad = fieldInvalid(key);
  return '<div class="row' + (wide ? ' wide' : '') + (bad ? ' invalid' : '') + '">'
    + '<div class="row-text">'
    +   '<div class="row-label">' + esc(f.label)
    +     (isDirty(key) ? '<span class="badge-mod">已修改</span>' : '')
    +   '</div>'
    +   (f.description ? '<div class="row-desc">' + esc(f.description) + '</div>' : '')
    +   (f.caution ? '<div class="row-caution">' + esc(f.caution) + '</div>' : '')
    +   (bad ? '<div class="row-caution">' + esc(bad) + '</div>' : '')
    + '</div>'
    + '<div class="row-control">' + renderControl(key)
    +   (isDirty(key) ? '<button class="revert" data-revert="' + key + '" title="放弃这项改动">' + ICON.revert + '</button>' : '')
    + '</div>'
    + '</div>';
}

/** 分区小标题：序号 + 标题 + 一句「为什么」。序号让「选服务商 → 填密钥 → 验证」的顺序一眼可见 */
function secHead(step, title, desc) {
  return '<div class="sec-head' + (step ? ' has-step' : '') + '">'
    + '<h2>' + (step ? '<span class="step">' + step + '</span>' : '') + title + '</h2>'
    + (desc ? '<p>' + desc + '</p>' : '')
    + '</div>';
}

function renderModelSection() {
  const meta = S.meta;
  const providers = S.schema.providers;
  const presets = S.schema.presets;
  const provider = draft['commitCraft.provider'];
  const requiresKey = provider !== 'ollama';
  const key = meta.key || {};

  const cards = presets.map(p => {
    const on = meta.activePresetKey === p.key && provider === p.provider;
    return '<button type="button" class="card' + (on ? ' active' : '') + '" data-preset="' + esc(p.key) + '"'
      + ' title="' + esc(p.label + ' · ' + p.description) + '">'
      + '<span class="c-ico">' + (PROV_ICONS[p.key] || PROV_ICONS.compatible) + '</span>'
      + '<span class="c-body">'
      +   '<span class="c-name">' + esc(p.label) + '</span>'
      +   '<span class="c-desc">' + esc(p.description) + '</span>'
      + '</span>'
      + '<span class="c-check">' + ICON.check + '</span>'
      + '</button>';
  }).join('');

  const keyStateText = provider === 'ollama'
    ? '<span class="k-state ok">本地服务，不需要密钥</span>'
    : (key.hasKey
        ? '<span class="k-state ok">已保存 ' + esc(key.masked || '') + '</span>'
        : (key.envName && key.envPresent
            ? '<span class="k-state ok">从环境变量 ' + esc(key.envName) + ' 读取</span>'
            : '<span class="k-state warn">未设置</span>'));

  const keyHint = (presets.find(p => p.key === meta.activePresetKey) || {}).keyHint || '';
  const keyBlock = requiresKey ? (
    '<div class="keybox">'
    + '<div class="k-head">' + ICON.key + '<span>API 密钥</span>' + keyStateText + '</div>'
    + '<div class="k-row">'
    +   '<input type="password" id="key-input" placeholder="粘贴密钥后点保存" spellcheck="false" value="' + esc(keyInput) + '">'
    +   '<button type="button" class="mini" id="btn-key-save"' + (keyBusy ? ' disabled' : '') + '>'
    +     (keyBusy ? '<span class="spin"></span>' : '') + '保存密钥</button>'
    +   (key.hasKey ? '<button type="button" class="mini" id="btn-key-clear"' + (keyBusy ? ' disabled' : '') + '>清除</button>' : '')
    + '</div>'
    + '<div class="k-hint">密钥存入 VSCode 加密凭据库（SecretStorage），不写 settings.json、不随 Settings Sync 同步、日志里只记录长度。</div>'
    + (keyHint ? '<div class="k-hint">获取方式：' + esc(keyHint) + '</div>' : '')
    + '</div>'
  ) : (
    '<div class="keybox"><div class="k-head">' + ICON.key + '<span>API 密钥</span>'
    + '<span class="k-state ok">Ollama 为本地服务，不需要密钥</span></div></div>'
  );

  const pickables = modelPickerOptions();
  const currentModel = String(draft['commitCraft.model'] || '');
  const pickEmpty = pickables.length === 0;

  const pickItems = pickEmpty
    ? '<div class="combo-empty">' + (modelsLoading
        ? '正在获取模型列表…'
        : '还没有模型列表。点右侧「获取模型」拉取，或在下方直接输入模型名。') + '</div>'
    : pickables.map((m, i) => '<button type="button" id="ccmi-' + i + '" class="combo-item' + (m.id === currentModel ? ' on' : '')
        + '" data-model="' + esc(m.id) + '" role="option" aria-selected="' + (m.id === currentModel) + '">'
        + '<span class="ci-name">' + esc(m.id) + '</span>'
        + (m.note ? '<span class="ci-note">' + esc(m.note) + '</span>' : '')
        + '<span class="ci-check">' + (m.id === currentModel ? ICON.check : '') + '</span>'
        + '</button>').join('');

  const combo = '<div class="combo' + (modelOpen ? ' is-open' : '') + '" id="model-combo">'
    + '<input type="text" id="model-input" data-key="commitCraft.model" autocomplete="off" spellcheck="false"'
    +   ' role="combobox" aria-expanded="' + (modelOpen ? 'true' : 'false') + '" aria-controls="model-pop"'
    +   ' aria-autocomplete="list" aria-label="模型"'
    +   ' value="' + esc(currentModel) + '" placeholder="' + esc(meta.defaultModel || '模型名称') + '">'
    + '<button type="button" class="combo-toggle" id="btn-model-toggle"'
    +   ' title="' + (pickEmpty ? '先点「获取模型」拉取列表' : '展开模型列表（' + pickables.length + ' 个）') + '"'
    +   ' aria-label="展开模型列表">' + (modelOpen ? ICON.chevUp : ICON.chev) + '</button>'
    + '<div class="combo-pop" id="model-pop" role="listbox"' + (modelOpen ? '' : ' hidden') + '>' + pickItems + '</div>'
    + '</div>';

  const mismatch = meta.mismatch ? '<div class="hint-inline">' + esc(meta.mismatch) + '</div>' : '';

  const fetchButton = '<button type="button" class="ghost small" id="btn-fetch-models"' + (modelsLoading ? ' disabled' : '') + '>'
    + (modelsLoading ? '<span class="spin"></span>' : ICON.refresh) + '获取模型</button>';

  const modelNotes = (models.length
      ? '<div class="hint-line">已获取 ' + models.length + ' 个模型，点右侧箭头可直接选；也可以继续手打模型名。</div>'
      : '')
    + (modelsError ? '<div class="hint-inline">获取失败：' + esc(modelsError) + '</div>' : '');

  const modelRow = '<div class="row wide">'
    + '<div class="row-text">'
    +   '<div class="row-label">模型' + (isDirty('commitCraft.model') ? '<span class="badge-mod">已修改</span>' : '') + '</div>'
    +   '<div class="row-desc">' + esc(meta.modelHint || '') + '。留空则用推荐默认模型「' + esc(meta.defaultModel || '—') + '」。</div>'
    +   modelNotes
    + '</div>'
    + '<div class="row-control">'
    +   combo
    +   (meta.supportsModelList ? fetchButton : '')
    +   (isDirty('commitCraft.model')
          ? '<button type="button" class="revert" data-revert="commitCraft.model" title="放弃这项改动">' + ICON.revert + '</button>'
          : '')
    + '</div></div>';

  const typeIcon = PROV_ICONS[TYPE_ICON[provider] || 'compatible'] || PROV_ICONS.compatible;
  const providerRow = '<div class="row">'
    + '<div class="row-text">'
    +   '<div class="row-label">' + typeIcon + '接口协议</div>'
    +   '<div class="row-desc">决定请求格式与鉴权方式。选上面的卡片会自动切换，只有接自建网关时才需要手动改。</div>'
    + '</div>'
    + '<div class="row-control"><span class="select-wrap">'
    + '<select data-key="commitCraft.provider">'
    + providers.map(p => '<option value="' + p.id + '"' + (p.id === provider ? ' selected' : '') + '>' + esc(p.label) + '</option>').join('')
    + '</select>' + ICON.chev + '</span></div></div>';

  return secHead(1, '选择服务商', '卡片是快捷键：点一下帮你把接口地址和推荐模型都填好，之后仍可自由修改。')
    + '<div class="picker">' + cards + '</div>'
    + mismatch
    + '<div class="sec-gap"></div>'
    + secHead(2, '连接与密钥', '地址、模型、密钥三者对得上，才能发得出去。')
    + '<div class="panel">'
    +   renderRow('commitCraft.baseUrl')
    +   modelRow
    +   keyBlock
    + '</div>'
    + '<div class="sec-gap"></div>'
    + secHead(3, '验证连接', '用当前配置发一条最短请求，比反复猜「是不是哪里配错了」快得多。')
    + '<div class="panel testbar">'
    +   '<button type="button" class="ghost" id="btn-test"' + (lastTest && lastTest.running ? ' disabled' : '') + '>'
    +     (lastTest && lastTest.running ? '<span class="spin"></span> 测试中…' : ICON.plug + ' 测试连接') + '</button>'
    +   '<span class="test-result ' + (lastTest ? (lastTest.running ? 'run' : (lastTest.ok ? 'ok' : 'err')) : '') + '">'
    +     (lastTest && !lastTest.running ? esc(lastTest.message) : '会验证接口地址、密钥、模型名三者是否匹配') + '</span>'
    + '</div>'
    + '<details class="adv"' + (advOpen ? ' open' : '') + '>'
    +   '<summary>更多选项<span class="adv-note">接口协议 · 模型列表 · 环境变量</span></summary>'
    +   '<div class="adv-body"><div class="panel">'
    +     providerRow
    +     renderRow('commitCraft.autoFetchModels')
    +     renderRow('commitCraft.availableModels')
    +     renderRow('commitCraft.apiKeyEnv')
    +   '</div></div>'
    + '</details>';
}

function renderFieldSections() {
  const sec = S.schema.sections.find(s => s.id === active) || S.schema.sections[0];
  if (sec.custom === 'model') return renderModelSection();
  return secHead(0, esc(sec.label), esc(sec.tagline))
    + '<div class="panel">' + sec.fields.map(f => renderRow(f.key)).join('') + '</div>';
}

function renderSearch() {
  const q = query.trim().toLowerCase();
  const hits = [];
  for (const sec of S.schema.sections) {
    const rows = sec.fields.filter(f =>
      (f.label + ' ' + (f.description || '') + ' ' + f.key).toLowerCase().indexOf(q) >= 0);
    if (rows.length) hits.push({ sec, rows });
  }
  if (!hits.length) return '<div class="empty">没有匹配「' + esc(query) + '」的设置项。<button type="button" class="link-btn" id="btn-clear-search">清除搜索</button></div>';
  return hits.map(h => '<div class="grid-title">' + esc(h.sec.label) + '</div>'
    + '<div class="panel">' + h.rows.map(f => renderRow(f.key)).join('') + '</div>').join('');
}

function renderHealth() {
  const h = S.health;
  const box = $('health');
  if (!h) { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'health ' + h.level;
  const overridden = S.meta.workspaceOverrides || [];
  const wsNote = overridden.length
    ? '<div class="h-detail">注意：' + overridden.slice(0, 4).map(esc).join('、')
      + (overridden.length > 4 ? ' 等 ' + overridden.length + ' 项' : '') 
      + ' 被工作区别的配置覆盖，本页保存的是全局值，可能不生效。</div>'
    : '';
  box.innerHTML = '<span class="dot"></span><div><span class="h-title">' + esc(h.title) + '</span>'
    + (h.detail ? '<div class="h-detail">' + esc(h.detail) + '</div>' : '') + wsNote + '</div>';
}

function renderSubtitle() {
  const m = S.meta;
  $('subtitle').textContent = m.providerLabel + ' · ' + (draft['commitCraft.model'] || m.defaultModel || '未设置模型')
    + (m.key && m.key.hasKey ? ' · 密钥已配置' : (m.requiresKey ? ' · 未配置密钥' : ''));
}

function renderFooter() {
  const n = dirty.size;
  const invalid = [...dirty].some(k => fieldInvalid(k));
  $('dirty').textContent = n ? (invalid ? '有 ' + n + ' 项待保存（其中含无效值）' : '有 ' + n + ' 项未保存') : '';
  $('btn-save').disabled = n === 0 || invalid;
  $('btn-reset').disabled = false;
  // dirty 变化上报宿主：标题出现 ●，首次变脏时提醒一次「直接关闭会丢失」
  if (n !== lastDirtyPosted) {
    lastDirtyPosted = n;
    vscode.postMessage({ type: 'dirtyChanged', dirty: n });
    if (n > 0 && !dirtyTipShown) {
      dirtyTipShown = true;
      toast('改动尚未保存：Ctrl+S 保存，或点底部「保存」；直接关闭页面会丢失改动', 'warn');
    }
  }
}

function render() {
  if (!S) return;
  renderNav();
  $('content').innerHTML = '<div class="page">' + (query ? renderSearch() : renderFieldSections()) + '</div>';
  renderHealth();
  renderSubtitle();
  renderFooter();
}

/* ---------------- 交互 ---------------- */

function markDirty(key, value) {
  draft[key] = value;
  const orig = toText(fieldMap()[key].field, S.values[key]);
  if (String(value) === String(orig)) dirty.delete(key); else dirty.add(key);
}

function toast(message, level) {
  const el = document.createElement('div');
  el.className = 'toast ' + (level || 'ok');
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* 模型下拉：展开 → 过滤 → 选中，全部走真实 DOM，不依赖 datalist */
function toggleModelPop(force) {
  const open = typeof force === 'boolean' ? force : !modelOpen;
  if (open && !modelPickerOptions().length) {
    toast(modelsLoading ? '正在获取模型列表…' : '还没有模型列表，先点「获取模型」', 'warn');
    return;
  }
  modelOpen = open;
  render();
  if (!open) return;
  const input = $('model-input');
  if (!input) return;
  input.focus();
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch (err) { /* 老 webview 不支持就忽略 */ }
  const on = document.querySelector('#model-pop .combo-item.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  syncModelActiveAttr();
}

function pickModel(id) {
  if (!id) return;
  markDirty('commitCraft.model', id);
  modelOpen = false;
  render();
  toast('已选择模型 ' + id, 'ok');
}

function filterModelList(q) {
  const pop = $('model-pop');
  if (!pop) return;
  const needle = String(q || '').trim().toLowerCase();
  let shown = 0;
  for (const item of pop.querySelectorAll('.combo-item')) {
    const hit = !needle || (item.textContent || '').toLowerCase().indexOf(needle) >= 0;
    item.hidden = !hit;
    if (hit) shown += 1;
  }
  const existing = pop.querySelector('.combo-none');
  if (!shown && !existing) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty combo-none';
    empty.textContent = '没有匹配的模型，可以直接用当前输入值';
    pop.appendChild(empty);
  } else if (shown && existing) {
    existing.remove();
  }
  // 过滤后，active 项可能被隐藏：清掉并同步 aria-activedescendant
  for (const el of pop.querySelectorAll('.combo-item.active')) {
    if (el.hidden) {
      el.classList.remove('active');
      syncModelActiveAttr();
    }
  }
}

/** 把 input 的 aria-activedescendant 指向当前 active 项；屏幕阅读器据此播报 */
function syncModelActiveAttr() {
  const input = $('model-input');
  if (!input) return;
  const act = document.querySelector('#model-pop .combo-item.active');
  if (act instanceof HTMLElement && act.id) {
    input.setAttribute('aria-activedescendant', act.id);
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function moveModelActive(delta) {
  const items = Array.prototype.filter.call(
    document.querySelectorAll('#model-pop .combo-item'),
    el => !el.hidden,
  );
  if (!items.length) {
    syncModelActiveAttr();
    return;
  }
  let idx = items.findIndex(el => el.classList.contains('active'));
  if (idx < 0) {
    const onIdx = items.findIndex(el => el.classList.contains('on'));
    idx = onIdx >= 0 ? onIdx : (delta > 0 ? -1 : items.length);
  }
  idx = (idx + delta + items.length) % items.length;
  for (const el of items) el.classList.remove('active');
  const next = items[idx];
  next.classList.add('active');
  if (next.scrollIntoView) next.scrollIntoView({ block: 'nearest' });
  syncModelActiveAttr();
}

document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+S：与底部保存按钮等价（保存前宿主还会做一次校验）
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    if (dirty.size > 0 && !$('btn-save').disabled) save();
    return;
  }
  if (e.target && e.target.id === 'model-input') {
    if (e.key === 'Escape') {
      if (modelOpen) { modelOpen = false; render(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!modelOpen) { toggleModelPop(true); return; }
      e.preventDefault();
      moveModelActive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // Home/End：跳到列表首/尾，便于长列表快速浏览
    if ((e.key === 'Home' || e.key === 'End') && modelOpen) {
      e.preventDefault();
      const items = Array.prototype.filter.call(
        document.querySelectorAll('#model-pop .combo-item'),
        el => !el.hidden,
      );
      if (!items.length) return;
      for (const el of items) el.classList.remove('active');
      const target = e.key === 'Home' ? items[0] : items[items.length - 1];
      target.classList.add('active');
      if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
      syncModelActiveAttr();
      return;
    }
    // Tab：合上下拉让焦点自然跳走，不强行阻止默认导航
    if (e.key === 'Tab' && modelOpen) { modelOpen = false; render(); return; }
    if (e.key === 'Enter' && modelOpen) {
      const act = document.querySelector('#model-pop .combo-item.active')
        || document.querySelector('#model-pop .combo-item.on');
      if (act) { e.preventDefault(); pickModel(act.dataset.model); }
      return;
    }
  }
  if (e.key === 'Escape' && modelOpen) { modelOpen = false; render(); }
});

document.addEventListener('click', (e) => {
  // 「更多选项」是原生 details，重绘时用 advOpen 还原展开状态
  if (e.target.closest('.adv > summary')) { advOpen = !advOpen; return; }

  // 模型下拉：展开/收起 → 选中某一项 → 点空白处收起
  if (e.target.closest('#btn-model-toggle')) { toggleModelPop(); return; }
  const modelItem = e.target.closest('.combo-item[data-model]');
  if (modelItem) { pickModel(modelItem.dataset.model); return; }
  if (modelOpen && !e.target.closest('#model-combo')) { modelOpen = false; render(); }

  const nav = e.target.closest('.nav-item');
  if (nav) { active = nav.dataset.section; query = ''; $('search').value = ''; render(); $('content').scrollTop = 0; return; }

  if (e.target.closest('#btn-clear-search')) { query = ''; $('search').value = ''; render(); $('search').focus(); return; }

  const revert = e.target.closest('[data-revert]');
  if (revert) {
    const key = revert.dataset.revert;
    draft[key] = toText(fieldMap()[key].field, S.values[key]);
    dirty.delete(key);
    render();
    return;
  }

  const card = e.target.closest('[data-preset]');
  if (card) {
    const p = S.schema.presets.find(x => x.key === card.dataset.preset);
    if (!p) return;
    draft['commitCraft.provider'] = p.provider;
    dirty.add('commitCraft.provider');
    draft['commitCraft.baseUrl'] = p.baseUrl;
    dirty.add('commitCraft.baseUrl');
    if (p.defaultModel) { draft['commitCraft.model'] = p.defaultModel; dirty.add('commitCraft.model'); }
    const d = (S.schema.providerDefaults || {})[p.provider] || {};
    S.meta.activePresetKey = p.key;
    S.meta.mismatch = '';
    S.meta.providerLabel = p.label;
    S.meta.providerTypeLabel = d.label || '';
    S.meta.modelHint = d.modelHint || '';
    // 推荐模型按具体入口算，DeepSeek 的兜底模型不该是 gpt-4o-mini
    S.meta.defaultModel = p.defaultModel || d.defaultModel || '';
    models = []; modelsError = ''; lastTest = null; modelOpen = false;
    render();
    vscode.postMessage({ type: 'queryKey', provider: p.provider });
    toast(p.baseUrl ? ('已选择 ' + p.label + '，记得点保存') : ('已选择 ' + p.label + '，还需要填写接口地址'), 'ok');
    return;
  }

  if (e.target.closest('#btn-save')) { save(); return; }
  if (e.target.closest('#btn-reset')) { resetSection(); return; }
  if (e.target.closest('#btn-native')) { vscode.postMessage({ type: 'openNative' }); return; }
  if (e.target.closest('#btn-fetch-models')) { fetchModels(); return; }
  if (e.target.closest('#btn-test')) { test(); return; }
  if (e.target.closest('#btn-key-save')) { saveKey(); return; }
  if (e.target.closest('#btn-key-clear')) {
    vscode.postMessage({ type: 'clearKey', provider: draft['commitCraft.provider'] });
    return;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'search') { query = el.value; render(); return; }
  if (el.id === 'key-input') { keyInput = el.value; return; }
  const key = el.dataset && el.dataset.key;
  if (!key) return;
  const meta = fieldMap()[key];
  if (!meta) return;
  const prevDirty = dirty.has(key);
  if (meta.field.type === 'boolean') markDirty(key, el.checked ? 'true' : 'false');
  else markDirty(key, el.value);

  // 只重画脏状态与错误提示，避免输入时丢焦点
  renderFooter();
  const row = el.closest('.row');
  if (row) {
    // URL 实时校验太吵（用户正在粘贴 / 输到一半协议前缀），blur 时再红框
    const liveCheck = key !== 'commitCraft.baseUrl';
    const bad = liveCheck ? fieldInvalid(key) : '';
    row.classList.toggle('invalid', !!bad);
    let warn = row.querySelector('.field-error');
    if (bad) {
      if (!warn) {
        warn = document.createElement('div');
        warn.className = 'row-caution field-error';
        row.querySelector('.row-text').appendChild(warn);
      }
      warn.textContent = bad;
    } else if (warn) {
      warn.remove();
    }
  }
  if (dirty.has(key) !== prevDirty) renderNav();
  // 拉开列表时边打字边过滤；列表没开就不打断输入
  if (key === 'commitCraft.model' && modelOpen) filterModelList(el.value);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const key = el.dataset && el.dataset.key;
  if (!key) return;
  // 只有下拉框与开关需要整块重画；文本框走 input 事件局部更新，避免丢焦点
  if (el.tagName !== 'SELECT' && el.type !== 'checkbox') return;
  if (key === 'commitCraft.provider') {
    const next = el.value;
    const d = (S.schema.providerDefaults || {})[next] || {};
    const knownUrls = S.schema.presets.map(p => (p.baseUrl || '').replace(/\\/+$/, '').toLowerCase());
    const current = String(draft['commitCraft.baseUrl'] || '').replace(/\\/+$/, '').toLowerCase();
    // 只在用户没自定义地址时才覆盖，避免把内网网关地址冲掉
    if (!current || knownUrls.indexOf(current) >= 0) {
      draft['commitCraft.baseUrl'] = d.baseUrl || '';
      dirty.add('commitCraft.baseUrl');
    }
    if (d.defaultModel && !String(draft['commitCraft.model'] || '').trim()) {
      draft['commitCraft.model'] = d.defaultModel;
      dirty.add('commitCraft.model');
    }
    S.meta.modelHint = d.modelHint || '';
    S.meta.defaultModel = d.defaultModel || '';
    S.meta.activePresetKey = '';
    const prov = S.schema.providers.find(x => x.id === next);
    S.meta.providerLabel = (prov && prov.label) || next;
    models = []; modelsError = ''; lastTest = null; keyInput = ''; modelOpen = false;
    vscode.postMessage({ type: 'queryKey', provider: next });
  }
  render();
});

// 失焦校验：URL 等文本字段在 input 事件里被跳过实时红框，blur 时一次性给反馈
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!el || !el.dataset) return;
  const key = el.dataset.key;
  if (key !== 'commitCraft.baseUrl') return;
  const row = el.closest('.row');
  if (!row) return;
  const bad = fieldInvalid(key);
  row.classList.toggle('invalid', !!bad);
  let warn = row.querySelector('.field-error');
  if (bad) {
    if (!warn) {
      warn = document.createElement('div');
      warn.className = 'row-caution field-error';
      const text = row.querySelector('.row-text');
      if (text) text.appendChild(warn);
      else row.appendChild(warn);
    }
    warn.textContent = bad;
  } else if (warn) {
    warn.remove();
  }
});

function collect() {
  const out = {};
  for (const key of Object.keys(draft)) {
    const meta = fieldMap()[key];
    if (!meta) continue;
    out[key] = fromText(meta.field, draft[key]);
  }
  return out;
}

function save() {
  if (dirty.size === 0) return;
  $('btn-save').disabled = true;
  vscode.postMessage({ type: 'save', values: collect() });
}

function resetSection() {
  const keys = S.schema.sections.find(s => s.id === active).fields.map(f => f.key);
  vscode.postMessage({ type: 'resetSection', section: active, keys });
}

function fetchModels() {
  modelsLoading = true; modelsError = ''; render();
  vscode.postMessage({
    type: 'fetchModels',
    provider: draft['commitCraft.provider'],
    baseUrl: draft['commitCraft.baseUrl'],
    key: keyInput,
  });
}

function test() {
  lastTest = { running: true };
  render();
  vscode.postMessage({
    type: 'test',
    values: collect(),
    key: keyInput,
  });
}

function saveKey() {
  if (!keyInput.trim()) { toast('先粘贴密钥', 'warn'); return; }
  keyBusy = true; render();
  vscode.postMessage({ type: 'saveKey', provider: draft['commitCraft.provider'], key: keyInput });
}

window.addEventListener('message', (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case 'state':
    case 'configChanged': {
      S = msg.state;
      types = {};
      draft = {};
      for (const sec of S.schema.sections) {
        for (const f of sec.fields) {
          types[f.key] = f.type;
          draft[f.key] = toText(f, S.values[f.key]);
        }
      }
      if (msg.type === 'state') { dirty.clear(); keyInput = ''; modelOpen = false; }
      else {
        // 配置被外部改动：已改未保存的项保留用户输入，其余跟随新值
        const keep = new Set(dirty);
        dirty.clear();
        for (const key of Object.keys(draft)) {
          if (keep.has(key)) { dirty.add(key); continue; }
          draft[key] = toText(fieldMap()[key].field, S.values[key]);
        }
      }
      models = S.meta.models || [];
      modelsError = '';
      modelsLoading = false;
      render();
      break;
    }
    case 'saved': {
      S = msg.state;
      dirty.clear();
      keyBusy = false;
      for (const sec of S.schema.sections) for (const f of sec.fields) draft[f.key] = toText(f, S.values[f.key]);
      models = S.meta.models || models;
      render();
      if (msg.undo) toast('已撤销恢复，「' + (S.schema.sections.find(s => s.id === msg.resetSection) || {}).label + '」的设置已还原', 'ok');
      else if (msg.resetSection) toast('已恢复「' + (S.schema.sections.find(s => s.id === msg.resetSection) || {}).label + '」的默认值', 'ok');
      else if (msg.changed > 0) toast('已保存 ' + msg.changed + ' 项设置', 'ok');
      else toast('没有需要保存的改动', 'warn');
      if (msg.warnings && msg.warnings.length) toast(msg.warnings[0], 'warn');
      break;
    }
    case 'saveFailed': {
      renderFooter();
      toast('未保存：' + ((msg.errors && msg.errors[0]) || '配置校验未通过'), 'error');
      break;
    }
    case 'keyState': {
      keyBusy = false;
      keyInput = '';
      if (S) { S.meta.key = msg.key; S.meta.requiresKey = msg.provider !== 'ollama'; }
      models = []; modelsError = ''; modelOpen = false;
      render();
      break;
    }
    case 'modelsLoading': { modelsLoading = true; modelsError = ''; modelOpen = false; render(); break; }
    case 'models': {
      modelsLoading = false;
      models = msg.models || [];
      modelsError = msg.error || '';
      // 拿到列表就直接展开：用户点「获取模型」的下一步一定是选一个
      modelOpen = models.length > 0;
      render();
      if (!modelsError) toast('获取到 ' + models.length + ' 个模型，点列表里的任意一项即可选中', 'ok');
      break;
    }
    case 'testRunning': { lastTest = { running: true }; render(); break; }
    case 'testResult': {
      lastTest = { ok: msg.ok, message: msg.message };
      render();
      toast(msg.ok ? '连接正常' : ('连接失败：' + msg.message), msg.ok ? 'ok' : 'error');
      break;
    }
    case 'toast': { toast(msg.message, msg.level); break; }
    case 'focusSection': {
      if (msg.section) { active = msg.section; query = ''; $('search').value = ''; render(); }
      break;
    }
  }
});

vscode.postMessage({ type: 'ready' });
`;

/* ------------------------------------------------------------------ 图标 */

const ICON_JSON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 2.6H3.4v10.8h1.8"/><path d="M10.8 2.6h1.8v10.8h-1.8"/><path d="M8 5.4v5.2M6.6 6.8 8 5.4l1.4 1.4"/></svg>`;

const ICON_SEARCH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.6 13.6"/></svg>`;

const ICON_SAVE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h7.2L13 5.8V13H3z"/><path d="M5.6 3v3.4h4.8V3"/><path d="M5.6 13V9.2h4.8V13"/></svg>`;
