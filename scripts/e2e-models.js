/**
 * 端到端验证（模型获取路径）：真实打包产物 + 桩 UI，检查
 *   1) 快速配置向导：选服务商 → 存密钥 → 自动获取模型 → 写入默认模型
 *   2) 「选择模型」在没有缓存时自动请求 /models
 *   3) 有缓存时不再发请求（只打缓存）
 *   4) autoFetchModels=false 时不自动请求，退化为手动输入
 */
const Module = require('module');
const path = require('path');

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

// ---------- 可变的配置与桩 ----------
const configValues = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  autoFetchModels: true,
  availableModels: [],
  temperature: 0.2,
  maxTokens: 1024,
  requestTimeoutMs: 20000,
  maxRetries: 0,
  apiKeyEnv: '',
  'commit.format': 'conventional',
  'commit.language': 'zh-CN',
  'commit.templateId': 'builtin-conventional-zh',
  'commit.maxSubjectLength': 72,
  'commit.includeBody': true,
  'commit.recentCommitCount': 5,
  'commit.confirmBeforeInsert': false,
  'diff.maxTotalChars': 48000,
  'diff.maxFileChars': 20000,
  'diff.excludeGlobs': [],
  'diff.redactSecrets': true,
  'review.templateId': 'builtin-review-standard',
  'review.minSeverity': 'low',
  'review.maxIssues': 30,
  'review.showDiagnostics': true,
  customTemplates: [],
};

const updates = [];
const stored = new Map();
const infos = [];
const errors = [];
const handlers = new Map();
const fetchCalls = [];
const quickPickCalls = [];
const inputBoxCalls = [];
let picker = () => undefined;
let inputBox = async () => undefined;

const disposable = () => ({ dispose() {} });

const vscodeStub = {
  version: '1.90.0',
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ViewColumn: { One: 1, Beside: -2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  MarkdownString: class {
    constructor(value) {
      this.value = value || '';
      this.isTrusted = false;
    }
    appendMarkdown(v) {
      this.value += v;
      return this;
    }
  },
  TreeItem: class {
    constructor(label, state) {
      Object.assign(this, { label, state });
    }
  },
  ThemeIcon: class {
    constructor(id, color) {
      Object.assign(this, { id, color });
    }
  },
  ThemeColor: class {
    constructor(id) {
      Object.assign(this, { id });
    }
  },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p }),
    joinPath: (base, ...parts) => vscodeStub.Uri.file(path.join(base.fsPath, ...parts)),
    parse: (s) => ({ scheme: 'file', fsPath: s, toString: () => s }),
  },
  Range: class {},
  Position: class {},
  Diagnostic: class {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  },
  CodeActionKind: { QuickFix: { value: 'quickfix' }, Refactor: { value: 'refactor' }, Source: { value: 'source' } },
  CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }); } },
  WorkspaceEdit: class { constructor() { this.changes = new Map(); } replace() {} insert() {} delete() {} },
  EventEmitter: class {
    constructor() {
      this.listeners = new Set();
      this.event = (l) => {
        this.listeners.add(l);
        return { dispose: () => this.listeners.delete(l) };
      };
    }
    fire(d) {
      for (const l of this.listeners) l(d);
    }
    dispose() {
      this.listeners.clear();
    }
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: undefined }),
    createTreeView: (id, opts) => ({
      id,
      treeDataProvider: opts && opts.treeDataProvider,
      description: '',
      message: '',
      reveal: async () => undefined,
      dispose() {},
    }),
    showInformationMessage: async (msg) => {
      infos.push(msg);
      return undefined;
    },
    showWarningMessage: async (msg) => {
      infos.push('[warn] ' + msg);
      return undefined;
    },
    showErrorMessage: async (msg) => {
      errors.push(msg);
      return undefined;
    },
    showQuickPick: async (items, opts) => {
      quickPickCalls.push({ items: items.map((i) => i && i.label), title: opts && opts.title });
      return picker(items, opts);
    },
    showInputBox: async (opts) => {
      inputBoxCalls.push(opts && opts.title);
      return inputBox(opts);
    },
    showTextDocument: async () => undefined,
    withProgress: async (_o, task) => task({ report: () => undefined }, { onCancellationRequested: () => disposable() }),
    createWebviewPanel: () => ({
      webview: { html: '', onDidReceiveMessage: () => disposable(), postMessage: async () => true },
      onDidDispose: () => disposable(),
      reveal: () => undefined,
      dispose: () => undefined,
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in configValues ? configValues[key] : fallback),
      update: async (key, value) => {
        updates.push({ key, value });
        configValues[key] = value;
      },
    }),
    onDidChangeConfiguration: () => disposable(),
    workspaceFolders: [],
    asRelativePath: (p) => p,
    openTextDocument: async () => ({ lineCount: 10 }),
  },
  commands: {
    registerCommand: (id, fn) => {
      handlers.set(id, fn);
      return disposable();
    },
    executeCommand: async () => undefined,
  },
  languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }), registerCodeActionsProvider: () => ({ dispose() {} }) },
  extensions: { getExtension: () => undefined },
  env: { language: 'zh-cn', clipboard: { writeText: async () => undefined } },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

// ---------- 假模型列表端点 ----------
let modelsResponse = {
  data: [
    { id: 'text-embedding-3-small', owned_by: 'system' },
    { id: 'deepseek-chat', owned_by: 'deepseek' },
    { id: 'gpt-4o-mini', owned_by: 'openai' },
  ],
};

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: init && init.method, auth: init && init.headers && init.headers.authorization });
  return new Response(JSON.stringify(modelsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
};

const memento = () => {
  const store = new Map();
  return {
    get: (k) => store.get(k),
    update: async (k, v) => {
      if (v === undefined) store.delete(k);
      else store.set(k, v);
      stored.set(k, v);
    },
  };
};

(async () => {
  const extension = require('../dist/extension.js');
  const secretStore = new Map();
  const secrets = {
    get: async (k) => secretStore.get(k),
    store: async (k, v) => secretStore.set(k, v),
    delete: async (k) => secretStore.delete(k),
  };
  const globalState = memento();
  const context = {
    subscriptions: [],
    secrets,
    globalState,
    workspaceState: memento(),
    extensionUri: vscodeStub.Uri.file(__dirname),
  };
  extension.activate(context);

  // ===== 阶段 1：快速配置向导（DeepSeek）=====
  let step = 0;
  picker = (items) => {
    step++;
    if (step === 1) {
      const target = items.find((i) => i && i.preset && i.preset.key === 'deepseek');
      check(!!target, '向导里找不到 DeepSeek 预设');
      return target;
    }
    // 第二个 picker 是模型列表：选被标为推荐的那条
    const preferred = items.find((i) => i && i.model === 'deepseek-chat');
    check(!!preferred, '模型列表中找不到 deepseek-chat');
    return preferred;
  };
  inputBox = async () => 'sk-deepseek-123456';

  await handlers.get('commitCraft.quickSetup')();

  const updateMap = Object.fromEntries(updates.map((u) => [u.key, u.value]));
  check(updateMap.provider === 'openai-compatible', `provider 未写入，实际 ${updateMap.provider}`);
  check(updateMap.baseUrl === 'https://api.deepseek.com/v1', `baseUrl 未写入，实际 ${updateMap.baseUrl}`);
  check(updateMap.model === 'deepseek-chat', `model 未写入，实际 ${updateMap.model}`);
  check(secretStore.get('commitCraft.apiKey.openai-compatible') === 'sk-deepseek-123456', '密钥未写入 SecretStorage');
  check(
    fetchCalls.some((c) => c.url === 'https://api.deepseek.com/v1/models' && c.auth === 'Bearer sk-deepseek-123456'),
    '未按服务商地址与密钥请求模型列表',
  );
  const cache = stored.get('commitCraft.modelCache.v1');
  check(!!cache && cache.models.length === 3, '模型列表未写入缓存');
  check(cache && cache.baseUrl === 'https://api.deepseek.com/v1', '缓存未记录接口地址');
  check(errors.length === 0, `向导阶段出现错误：${errors.join(' | ')}`);

  // ===== 阶段 2：切换地址后「选择模型」应自动拉取 =====
  updates.length = 0;
  fetchCalls.length = 0;
  configValues.baseUrl = 'https://api.openai.com/v1';
  configValues.model = 'deepseek-chat';
  step = 0;
  picker = (items) => items.find((i) => i && i.model === 'gpt-4o-mini');
  inputBox = async () => undefined;

  await handlers.get('commitCraft.selectModel')();

  check(fetchCalls.length === 1, `缓存不匹配时应自动请求 1 次，实际 ${fetchCalls.length}`);
  check(fetchCalls[0] && fetchCalls[0].url === 'https://api.openai.com/v1/models', '自动请求的地址不正确');
  check(
    updates.some((u) => u.key === 'model' && u.value === 'gpt-4o-mini'),
    `选择后未写入 model，实际 ${JSON.stringify(updates)}`,
  );

  // ===== 阶段 3：同一地址再选一次，应命中缓存、不发请求 =====
  fetchCalls.length = 0;
  updates.length = 0;
  picker = (items) => items.find((i) => i && i.model === 'deepseek-chat');
  await handlers.get('commitCraft.selectModel')();
  check(fetchCalls.length === 0, `命中缓存时不应再请求，实际 ${fetchCalls.length} 次`);

  // ===== 阶段 4：关闭自动获取 + 换地址 → 不请求，只给手动入口 =====
  fetchCalls.length = 0;
  configValues.autoFetchModels = false;
  configValues.baseUrl = 'https://gw.example.com/v1';
  picker = (items) => {
    const manual = items.find((i) => i && i.action === 'input');
    check(!!manual, '关闭自动获取后应仍然提供手动输入入口');
    return undefined;
  };
  await handlers.get('commitCraft.selectModel')();
  check(fetchCalls.length === 0, `已关闭自动获取，不应请求接口，实际 ${fetchCalls.length} 次`);

  report();

  function report() {
    if (failures.length > 0) {
      console.error('模型获取端到端验证失败：');
      for (const f of failures) console.error('  - ' + f);
      process.exit(1);
    }
    console.log(
      '模型获取端到端验证通过：向导写入服务商/地址/密钥 → 自动获取模型 → 缓存命中不重复请求 → 关闭自动获取后不请求',
    );
  }
})();
