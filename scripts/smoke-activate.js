/**
 * 冒烟测试：在纯 Node 里用一个最小 vscode 桩加载打包产物，验证
 * activate() 不抛错、12 个命令全部注册成功。
 *
 * 只检查"接线"是否正确（命令 id、API 用法、构造顺序），不模拟真实 UI。
 */
const Module = require('module');
const path = require('path');

const registered = new Map();
const executeCalls = [];
const disposables = [];

function disposable(name) {
  const d = { name, dispose() {} };
  disposables.push(d);
  return d;
}

const outputChannel = { appendLine: () => undefined, show: () => undefined, dispose: () => undefined };
const statusBarItem = {
  name: '',
  text: '',
  tooltip: '',
  command: undefined,
  show() {},
  hide() {},
  dispose() {},
};
const diagnosticCollection = { clear() {}, set() {}, delete() {}, dispose() {} };

const vscodeStub = {
  version: '1.90.0',
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ViewColumn: { One: 1, Beside: -2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
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
    constructor(a, b, c, d) {
      Object.assign(this, { a, b, c, d });
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
    createOutputChannel: () => outputChannel,
    createStatusBarItem: () => statusBarItem,
    createTreeView: (id, opts) => ({
      id,
      treeDataProvider: opts && opts.treeDataProvider,
      description: '',
      message: '',
      visible: true,
      reveal: async () => undefined,
      dispose() {},
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => undefined,
    withProgress: async (_opts, task) =>
      task({ report: () => undefined }, { onCancellationRequested: () => disposable('cancel') }),
    createWebviewPanel: () => ({
      webview: {
        html: '',
        onDidReceiveMessage: () => disposable('msg'),
        postMessage: async () => true,
      },
      onDidDispose: () => disposable('dispose'),
      reveal: () => undefined,
      dispose: () => undefined,
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => disposable('config'),
    onDidChangeTextDocument: () => disposable('textdoc'),
    workspaceFolders: [],
    asRelativePath: (p) => p,
    openTextDocument: async () => ({ lineCount: 10 }),
  },
  commands: {
    registerCommand: (id, handler) => {
      registered.set(id, handler);
      return disposable(id);
    },
    executeCommand: async (id, ...args) => {
      executeCalls.push({ id, args });
      return undefined;
    },
  },
  languages: { createDiagnosticCollection: () => diagnosticCollection },
  extensions: { getExtension: () => undefined },
  env: { language: 'zh-cn', clipboard: { writeText: async () => undefined } },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../dist/extension.js');

function memento() {
  const store = new Map();
  return {
    get: (key) => store.get(key),
    update: async (key, value) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
}

const context = {
  subscriptions: [],
  secrets: {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  },
  globalState: memento(),
  workspaceState: memento(),
  extensionUri: vscodeStub.Uri.file(__dirname),
};

const failures = [];

try {
  extension.activate(context);
} catch (err) {
  failures.push(`activate 抛出异常：${err && err.stack}`);
}

const expected = [
  'commitCraft.generateCommitMessage',
  'commitCraft.generateWithTemplate',
  'commitCraft.reviewStagedChanges',
  'commitCraft.showReviewReport',
  'commitCraft.copyReviewMarkdown',
  'commitCraft.clearReview',
  'commitCraft.revealReviewView',
  'commitCraft.goToIssue',
  'commitCraft.quickSetup',
  'commitCraft.selectModel',
  'commitCraft.refreshModels',
  'commitCraft.setApiKey',
  'commitCraft.clearApiKey',
  'commitCraft.testConnection',
  'commitCraft.cancelRequest',
  'commitCraft.restoreDraft',
  'commitCraft.openSettings',
  'commitCraft.openSettingsPage',
  'commitCraft.openNativeSettings',
  'commitCraft.showOutput',
  'commitCraft.clearDiagnostics',
];

for (const id of expected) {
  if (!registered.has(id)) {
    failures.push(`命令未注册：${id}`);
  }
}

if (context.subscriptions.length < expected.length) {
  failures.push(`subscriptions 数量不足：${context.subscriptions.length}`);
}

const setContextCalls = executeCalls.filter((c) => c.id === 'setContext');
if (setContextCalls.length < 2) {
  failures.push(`未正确初始化 context key（setContext 调用 ${setContextCalls.length} 次）`);
}

try {
  extension.deactivate();
} catch (err) {
  failures.push(`deactivate 抛出异常：${err}`);
}

if (failures.length > 0) {
  console.error('冒烟测试失败：');
  for (const f of failures) {
    console.error('  - ' + f);
  }
  process.exit(1);
}

console.log(`冒烟测试通过：activate 正常，${registered.size} 个命令已注册，${context.subscriptions.length} 个可释放资源。`);
