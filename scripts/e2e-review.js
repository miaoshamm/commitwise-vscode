/**
 * 端到端验证（审查路径）：真实 git 仓库 → 审查命令 → 断言
 *   1) 请求体带有 JSON 输出约束
 *   2) 模型给出"越界行号"与"不存在的文件"时，被分别降级 / 丢弃
 *   3) 只有可靠定位的问题进入编辑器诊断
 *   4) 报告 HTML 正常生成且包含问题标题
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

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitcraft-e2e-review-'));
const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
git('config', 'user.email', 'e2e@example.com');
git('config', 'user.name', 'E2E');
git('config', 'commit.gpgsign', 'false');

fs.writeFileSync(path.join(repoDir, 'service.ts'), 'export function run() {\n  return 1;\n}\n');
git('add', '.');
git('commit', '-q', '-m', 'chore: init');

// 追加两行新增内容：新增行号为 4 和 5
fs.writeFileSync(
  path.join(repoDir, 'service.ts'),
  'export function run() {\n  return 1;\n}\nexport const token = "abc";\nexport const unused = 2;\n',
);
git('add', 'service.ts');

const configValues = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.test.local/v1',
  model: 'test-model',
  availableModels: [],
  temperature: 0.2,
  maxTokens: 2048,
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
  'diff.excludeGlobs': [],
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
const diagnostics = new Map();
let panelHtml = '';
let clipboard = '';
let treeViewInstance;

const repository = {
  rootUri: { scheme: 'file', fsPath: repoDir, toString: () => 'file://' + repoDir },
  inputBox: { value: '' },
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
  Range: class {
    constructor(startLine, startChar, endLine, endChar) {
      Object.assign(this, { startLine, startChar, endLine, endChar });
    }
  },
  Position: class {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  },
  Diagnostic: class {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  },
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
    createTreeView: (id, opts) => {
      treeViewInstance = {
        id,
        treeDataProvider: opts && opts.treeDataProvider,
        description: '',
        message: '',
        visible: true,
        reveal: async () => undefined,
        dispose() {},
      };
      return treeViewInstance;
    },
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
    createWebviewPanel: () => {
      const panel = {
        webview: {
          set html(v) {
            panelHtml = v;
          },
          get html() {
            return panelHtml;
          },
          onDidReceiveMessage: () => disposable(),
          postMessage: async () => true,
        },
        onDidDispose: () => disposable(),
        reveal: () => undefined,
        dispose: () => undefined,
      };
      return panel;
    },
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
    executeCommand: async (id, ...args) => {
      const fn = handlers.get(id);
      if (fn && id !== 'commitCraft.cancelRequest') {
        await fn(...args);
      }
      return undefined;
    },
  },
  languages: {
    createDiagnosticCollection: () => ({
      clear: () => diagnostics.clear(),
      set: (uri, diags) => diagnostics.set(uri.toString(), diags),
      dispose: () => undefined,
    }),
  },
  extensions: {
    getExtension: (id) =>
      id === 'vscode.git' ? { isActive: true, exports: { getAPI: () => ({ repositories: [repository] }) } } : undefined,
  },
  env: { language: 'zh-cn', clipboard: { writeText: async (t) => { clipboard = t; } } },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

const requests = [];
const reviewPayload = {
  summary: '新增了两处导出，其中一处硬编码了疑似令牌。',
  issues: [
    {
      file: 'service.ts',
      line: 4,
      severity: 'high',
      category: 'security',
      title: '疑似硬编码令牌',
      detail: 'token 常量直接写在源码中，会随仓库泄露。',
      suggestion: '改为从环境变量读取。',
    },
    {
      file: 'service.ts',
      line: 2,
      severity: 'medium',
      category: 'maintainability',
      title: '未使用的变量',
      detail: '这一行并非本次新增，行号应按新增行给出。',
    },
    {
      file: 'src/ghost.ts',
      line: 10,
      severity: 'low',
      category: 'style',
      title: '臆造的问题',
      detail: '该文件不在本次暂存区中。',
    },
  ],
};

globalThis.fetch = async (url, init) => {
  requests.push({ url, body: JSON.parse(init.body) });
  const encoder = new TextEncoder();
  const text = JSON.stringify(reviewPayload);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

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

  const review = handlers.get('commitCraft.reviewStagedChanges');
  check(typeof review === 'function', '未注册 reviewStagedChanges');
  if (!review) {
    finish();
    return;
  }

  await review();

  // 请求约束
  check(requests.length === 1, `期望 1 次请求，实际 ${requests.length}`);
  if (requests[0]) {
    const prompt = requests[0].body.messages.map((m) => m.content).join('\n');
    check(prompt.includes('JSON'), '审查提示词缺少 JSON 输出约束');
    check(prompt.includes('severity'), '审查提示词缺少字段说明');
    check(prompt.includes('export const token'), '提示词缺少真实 diff 内容');
  }

  const allDiagnostics = [...diagnostics.values()].flat();
  check(diagnostics.size === 1, `应只在 1 个文件中打诊断，实际 ${diagnostics.size}`);
  check(allDiagnostics.length === 1, `应只有 1 条可精确定位的问题，实际 ${allDiagnostics.length}`);
  if (allDiagnostics[0]) {
    check(allDiagnostics[0].range.startLine === 3, `诊断行号应为 0-based 3（即第 4 行），实际 ${allDiagnostics[0].range.startLine}`);
    check(allDiagnostics[0].source === 'CommitCraft', '诊断 source 未设置');
  }

  check(panelHtml.includes('疑似硬编码令牌'), '报告未包含有效问题');
  check(panelHtml.includes('已忽略') || panelHtml.includes('降级'), '报告未说明被丢弃/降级的问题');
  check(!panelHtml.includes('臆造的问题'), '报告不应展示指向未知文件的问题');

  // 工具条三个按钮必须各带一枚内联图标，且文字包在 .lbl 里（复制反馈只改 .lbl，否则图标会一起消失）
  const iconCount = (panelHtml.match(/class="btn-ico"/g) ?? []).length;
  check(iconCount === 3, `三个工具按钮应各带一个内联图标，实际 ${iconCount} 个`);
  check(panelHtml.includes('<span class="lbl">复制为 Markdown</span>'), '复制按钮缺少 .lbl 文字容器');

  // 结果必须落到可复用存储里（这是"关掉报告还能再打开"的前提）
  const stored = context.workspaceState.get('commitCraft.lastReview.v1');
  check(!!stored, '审查结果没有写入 workspaceState');
  if (stored) {
    // 2 条：1 条精确定位（高危）+ 1 条行号越界被降级为文件级（中危）
    check(stored.issues.length === 2, `存储的问题数应为 2，实际 ${stored.issues.length}`);
    check(stored.counts.high === 1, `存储的高危数应为 1，实际 ${stored.counts.high}`);
    const downgraded = stored.issues.find((i) => i.title.includes('未使用'));
    check(!!downgraded, '降级后的文件级问题丢失');
    if (downgraded) {
      check(downgraded.anchor === 'file', `越界行号应降级为文件级，实际 ${downgraded.anchor}`);
      check(downgraded.line === undefined, '降级后不应保留行号');
    }
    check(stored.notices.length >= 2, `存储的说明条数应 >= 2，实际 ${stored.notices.length}`);
    check(stored.root === repoDir, '存储的仓库根目录不正确');
  }

  // 侧边栏清单：按文件分组，问题可点击跳转
  const tree = treeViewInstance;
  check(!!tree, '未创建审查问题视图');
  if (tree && tree.treeDataProvider) {
    const roots = tree.treeDataProvider.getChildren();
    const fileNodes = roots.filter((n) => n.kind === 'file');
    check(fileNodes.length === 1, `侧边栏应有 1 个文件节点，实际 ${fileNodes.length}`);
    const issueNodes = tree.treeDataProvider.getChildren(fileNodes[0]);
    check(issueNodes.length === 2, `文件节点下应有 2 条问题，实际 ${issueNodes.length}`);
    const first = issueNodes[0];
    if (first) {
      const item = tree.treeDataProvider.getTreeItem(first);
      check(item.command && item.command.command === 'commitCraft.goToIssue', '问题条目缺少跳转命令');
      check(String(item.label).includes('硬编码'), `高危问题应排在最前，实际 ${item.label}`);
    }
    check(tree.description.includes('2'), `视图描述应包含问题数，实际 "${tree.description}"`);
  }

  // 关掉面板后仍能重新打开（"结果没有地方看"的修复点）
  panelHtml = '';
  await handlers.get('commitCraft.showReviewReport')();
  check(panelHtml.includes('疑似硬编码令牌'), '重新打开报告失败：面板没有内容');

  // 复制为 Markdown
  await handlers.get('commitCraft.copyReviewMarkdown')();
  check(clipboard.includes('# CommitCraft 代码审查报告'), '复制的 Markdown 缺少标题');
  check(clipboard.includes('疑似硬编码令牌'), '复制的 Markdown 缺少问题标题');
  check(clipboard.includes('第 4 行'), '复制的 Markdown 缺少行号定位');

  // 清空后侧边栏应为空、存储被清掉
  await handlers.get('commitCraft.clearReview')();
  check(diagnostics.size === 0, '清空后诊断未清除');
  check(!context.workspaceState.get('commitCraft.lastReview.v1'), '清空后存储未删除');

  check(errors.length === 0, `出现错误提示：${errors.join(' | ')}`);

  finish();

  function finish() {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (failures.length > 0) {
      console.error('审查端到端验证失败：');
      for (const f of failures) console.error('  - ' + f);
      process.exit(1);
    }
    console.log(
      '审查端到端验证通过：JSON 解析 → 行号校验（越界降级）→ 未知文件丢弃 → 诊断与报告 → 侧边栏清单 → 重新打开报告 → 复制 Markdown → 清空',
    );
  }
})();
