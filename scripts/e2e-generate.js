/**
 * 端到端验证：临时 git 仓库 → 执行"生成提交信息"命令 → 断言
 *   1) 请求发到了正确的 URL、带上了正确密钥
 *   2) 请求体里包含真实暂存区 diff、且不含被排除文件与明文密钥
 *   3) 模型返回的提交信息被写进 SCM 输入框，原草稿可恢复
 *
 * 用最小 vscode 桩替代扩展宿主，其余全部走真实代码路径。
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

process.env.COMMITCRAFT_TEST_KEY = 'sk-test-key-123456';

// ---------- 准备真实仓库 ----------
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitcraft-e2e-'));
const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'E2E');
git('config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const a = 1;\n');
git('add', '.');
git('commit', '-q', '-m', 'chore: 初始化仓库');

fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const a = 1;\nexport const b = 2;\n');
fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
git('add', 'index.ts', 'package-lock.json');

// ---------- vscode 桩 ----------
const configValues = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.test.local/v1',
  model: 'test-model',
  availableModels: [],
  temperature: 0.2,
  maxTokens: 1024,
  requestTimeoutMs: 20000,
  maxRetries: 0,
  apiKeyEnv: 'COMMITCRAFT_TEST_KEY',
  'commit.format': 'conventional',
  'commit.language': 'zh-CN',
  'commit.templateId': 'builtin-conventional-zh',
  'commit.maxSubjectLength': 72,
  'commit.includeBody': true,
  'commit.recentCommitCount': 5,
  'commit.confirmBeforeInsert': false,
  'diff.maxTotalChars': 48000,
  'diff.maxFileChars': 20000,
  'diff.excludeGlobs': ['**/package-lock.json'],
  'diff.redactSecrets': true,
  'review.templateId': 'builtin-review-standard',
  'review.minSeverity': 'low',
  'review.maxIssues': 30,
  'review.showDiagnostics': true,
  customTemplates: [],
};

const infos = [];
const errors = [];
const handlers = new Map();

const repository = {
  rootUri: { scheme: 'file', fsPath: repoDir, toString: () => 'file://' + repoDir },
  inputBox: { value: '我手写了一半的提交信息' },
  state: { HEAD: { name: 'main' } },
};

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
    appendText(v) {
      this.value += v;
      return this;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      Object.assign(this, { label, collapsibleState });
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
  Diagnostic: class {},
  CodeActionKind: { QuickFix: { value: 'quickfix' }, Refactor: { value: 'refactor' }, Source: { value: 'source' } },
  CodeAction: class {},
  WorkspaceEdit: class {},
  EventEmitter: class {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    fire(data) {
      for (const l of this.listeners) l(data);
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
      visible: true,
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
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => undefined,
    withProgress: async (_opts, task) => task({ report: () => undefined }, { onCancellationRequested: () => disposable() }),
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
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => disposable(),
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: repoDir, toString: () => 'file://' + repoDir }, name: 'e2e', index: 0 }],
    asRelativePath: (p) => p,
    openTextDocument: async () => ({ lineCount: 20 }),
  },
  commands: {
    registerCommand: (id, fn) => {
      handlers.set(id, fn);
      return disposable();
    },
    executeCommand: async () => undefined,
  },
  languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }), registerCodeActionsProvider: () => ({ dispose() {} }) },
  extensions: {
    getExtension: (id) =>
      id === 'vscode.git' ? { isActive: true, exports: { getAPI: () => ({ repositories: [repository] }) } } : undefined,
  },
  env: { language: 'zh-cn', clipboard: { writeText: async () => undefined } },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

// ---------- 假模型端点 ----------
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url, init, body: JSON.parse(init.body) });
  const encoder = new TextEncoder();
  const frames = [
    'data: {"choices":[{"delta":{"content":"feat(api): 新增导出常量"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"\\n\\n- 新增 b 常量导出"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

// ---------- 跑 ----------
(async () => {
  const extension = require('../dist/extension.js');
  const memento = () => {
    const store = new Map();
    return {
      get: (k) => store.get(k),
      update: async (k, v) => {
        if (v === undefined) store.delete(k);
        else store.set(k, v);
      },
    };
  };
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    globalState: memento(),
    workspaceState: memento(),
    extensionUri: vscodeStub.Uri.file(__dirname),
  };
  extension.activate(context);

  const generate = handlers.get('commitCraft.generateCommitMessage');
  check(typeof generate === 'function', '未捕获到 generateCommitMessage handler');
  if (!generate) {
    report();
    return;
  }

  await generate();

  // 1) 请求正确
  check(requests.length === 1, `期望 1 次模型请求，实际 ${requests.length}`);
  if (requests.length > 0) {
    const req = requests[0];
    check(req.url === 'https://api.test.local/v1/chat/completions', `URL 不正确：${req.url}`);
    check(req.init.headers.authorization === 'Bearer sk-test-key-123456', 'Authorization 头不正确');
    check(req.body.model === 'test-model', '模型名不正确');
    check(req.body.stream === true, '未开启流式');

    const prompt = req.body.messages.map((m) => m.content).join('\n');
    check(prompt.includes('export const b = 2;'), '提示词中缺少真实 diff 内容');
    check(!prompt.includes('lockfileVersion'), '被排除的 lockfile 内容仍被发送');
    check(prompt.includes('package-lock.json'), '文件清单中应保留被排除的文件名');
    check(prompt.includes('chore: 初始化仓库'), '提示词中缺少最近提交作为风格参考');
    check(prompt.includes('简体中文'), '未按配置输出语言');
  }

  // 2) 写入输入框
  check(
    repository.inputBox.value === 'feat(api): 新增导出常量\n\n- 新增 b 常量导出',
    `输入框内容不正确：${JSON.stringify(repository.inputBox.value)}`,
  );

  // 3) 无错误提示
  check(errors.length === 0, `出现错误提示：${errors.join(' | ')}`);

  // 4) 草稿恢复
  const restore = handlers.get('commitCraft.restoreDraft');
  if (restore) {
    await restore();
    check(repository.inputBox.value === '我手写了一半的提交信息', '恢复草稿失败');
  }

  report();

  function report() {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (failures.length > 0) {
      console.error('端到端验证失败：');
      for (const f of failures) console.error('  - ' + f);
      process.exit(1);
    }
    console.log('端到端验证通过：真实 git 仓库 → 请求构造 → 流式解析 → 写入 SCM 输入框 → 草稿恢复');
  }
})();
