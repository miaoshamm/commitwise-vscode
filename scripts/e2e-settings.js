/**
 * 端到端验证（设置页）：真实 Webview 脚本 + 真实消息链路 + 真实写配置
 *
 * 与其他 e2e 不同的是，这里用 jsdom 真正执行了 webview 里的脚本，
 * 所以能验证「点一下服务商卡片 → 点保存 → settings.json 被写入」这条完整路径，
 * 而不只是断言宿主收到一条消息。
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

const pkg = require('../package.json');
const PROPS = pkg.contributes.configuration.properties;

const configStore = {};
const workspaceValues = {};
const updateCalls = [];
const secretStore = new Map();
const commandHandlers = new Map();
const posted = [];
const executed = [];
const toasts = [];
let panelInstance;
let messageHandler;
let html = '';

const disposable = () => ({ dispose() {} });

const vscodeStub = {
  version: '1.90.0',
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ViewColumn: { One: 1, Active: -1, Beside: -2 },
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
  TreeItem: class {
    constructor(label, state) {
      Object.assign(this, { label, collapsibleState: state });
    }
  },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p }),
    joinPath: (base, ...parts) => vscodeStub.Uri.file(path.join(base.fsPath, ...parts)),
    parse: (s) => ({ scheme: 'file', fsPath: s, toString: () => s }),
  },
  Range: class {
    constructor(a, b, c, d) {
      Object.assign(this, { startLine: a, startChar: b, endLine: c, endChar: d });
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
    createTreeView: () => ({ description: '', message: '', dispose() {}, reveal: async () => undefined }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => '恢复默认',
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => undefined,
    withProgress: async (_o, task) => task({ report: () => undefined }, { onCancellationRequested: () => disposable() }),
    createWebviewPanel: (viewType, title, column, options) => {
      panelInstance = {
        viewType,
        title,
        options,
        iconPath: undefined,
        webview: {
          html: '',
          cspSource: 'vscode-webview://test',
          asWebviewUri: (uri) => uri,
          onDidReceiveMessage: (cb) => {
            messageHandler = cb;
            return disposable();
          },
          postMessage: async (msg) => {
            posted.push(msg);
            return true;
          },
        },
        onDidDispose: () => disposable(),
        reveal: () => undefined,
        dispose: () => undefined,
      };
      Object.defineProperty(panelInstance.webview, 'html', {
        get: () => html,
        set: (v) => {
          html = v;
        },
      });
      return panelInstance;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get(key, fallback) {
        if (key in configStore) return configStore[key];
        const prop = PROPS['commitCraft.' + key];
        return prop && 'default' in prop ? prop.default : fallback;
      },
      inspect(key) {
        const prop = PROPS['commitCraft.' + key];
        if (!prop) return undefined;
        return {
          key: 'commitCraft.' + key,
          defaultValue: prop.default,
          globalValue: configStore[key],
          workspaceValue: workspaceValues[key],
          workspaceFolderValue: undefined,
        };
      },
      async update(key, value, target) {
        updateCalls.push({ key, value, target });
        configStore[key] = value;
      },
    }),
    onDidChangeConfiguration: () => disposable(),
    workspaceFolders: [],
    asRelativePath: (p) => p,
    openTextDocument: async () => ({ lineCount: 10 }),
  },
  commands: {
    registerCommand: (id, fn) => {
      commandHandlers.set(id, fn);
      return disposable();
    },
    executeCommand: async (id, ...args) => {
      executed.push({ id, args });
      const fn = commandHandlers.get(id);
      if (fn) {
        await fn(...args);
      }
      return undefined;
    },
  },
  languages: {
    createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }),
    registerCodeActionsProvider: () => ({ dispose() {} }),
  },
  extensions: { getExtension: () => undefined },
  env: { language: 'zh-cn', clipboard: { writeText: async () => undefined } },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

/* ------------------------------------------------------------ 网络桩 */

const requests = [];
global.fetch = async (url, opts) => {
  const target = String(url);
  requests.push({ url: target, method: (opts && opts.method) || 'GET', body: opts && opts.body });
  if (target.endsWith('/models')) {
    return new Response(
      JSON.stringify({
        data: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-reasoner' },
          { id: 'text-embedding-3-small' },
          { id: 'deepseek-coder' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
      c.enqueue(encoder.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

/* ------------------------------------------------------------ 执行 */

(async () => {
  const { JSDOM } = require('jsdom');
  const extension = require('../dist/extension.js');
  const context = {
    subscriptions: [],
    // 扩展真实 ID：改 package.json 的 publisher 时这里要同步，否则「原生设置」过滤器会指向不存在的扩展
    extension: { id: 'miaosha-ikio.commitwise' },
    secrets: {
      get: async (k) => secretStore.get(k),
      store: async (k, v) => secretStore.set(k, v),
      delete: async (k) => secretStore.delete(k),
    },
    globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
    extensionUri: vscodeStub.Uri.file(path.join(__dirname, '..')),
  };
  extension.activate(context);

  // 1) 打开设置页
  await vscodeStub.commands.executeCommand('commitCraft.openSettings');
  check(commandHandlers.size >= 19, `命令注册数量偏少：${commandHandlers.size}`);

  check(panelInstance !== undefined, '没有创建设置页面板');
  if (!panelInstance) {
    return finish();
  }
  check(panelInstance.viewType === 'commitCraft.settings', `面板类型不对：${panelInstance.viewType}`);
  check(panelInstance.options.enableScripts === true, '面板没有开启脚本');
  check(panelInstance.options.retainContextWhenHidden === true, '切走会丢未保存改动');
  check(typeof messageHandler === 'function', '没有注册消息处理器');

  // 2) 静态外壳
  check(html.includes('CommitCraft 设置'), 'HTML 缺少标题');
  check(html.includes('id="nav"') && html.includes('id="content"') && html.includes('id="btn-save"'), 'HTML 缺少骨架节点');
  check(/script-src 'nonce-/.test(html), 'CSP 没有限定 nonce');
  check(html.includes('default-src \'none\''), 'CSP 默认源不是 none');

  // 3) 真正执行 webview 脚本
  const scriptMatch = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  check(Boolean(scriptMatch), '没有找到内联脚本');
  if (!scriptMatch) {
    return finish();
  }
  const scriptText = scriptMatch[1];
  check(!/\$\{/.test(scriptText), '脚本里残留了未展开的模板占位符');
  check(!scriptText.includes('__PROV_ICONS__'), '服务商图标没有注入脚本');
  check(!scriptText.includes('__TYPE_ICON__'), '接口协议图标映射没有注入脚本');
  /*
   * 图标尺寸必须由 CSS 兜底：内联 <svg> 若没有尺寸约束，在 flex 容器里会按容器撑开，
   * 页面上就会出现一个巨大的图标（密钥区标题曾经就是这样）。这里守住兜底规则本身。
   */
  check(/svg\s*\{[^}]*width:\s*14px/.test(html), '缺少全局 svg 尺寸兜底');
  check(html.includes('.k-head > svg'), '密钥区标题的图标没有尺寸约束');
  check(html.includes('.c-ico svg'), '服务商卡片的图标没有尺寸约束');

  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/, ''), { runScripts: 'outside-only' });
  const { window } = dom;
  const doc = window.document;
  window.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
  let scriptError = null;
  try {
    window.eval(scriptText);
  } catch (err) {
    scriptError = err;
  }
  check(!scriptError, `webview 脚本执行报错：${scriptError && scriptError.message}`);
  if (scriptError) {
    return finish();
  }

  // ready 消息
  check(
    posted.some((m) => m.type === 'ready'),
    '脚本没有发出 ready',
  );
  await messageHandler({ type: 'ready' });

  const state = posted.filter((m) => m.type === 'state').pop();
  check(Boolean(state), '宿主没有响应 state');
  if (!state) {
    return finish();
  }
  check(Object.keys(state.state.values).length >= 20, `下发的配置项太少：${Object.keys(state.state.values).length}`);
  check(state.state.schema.sections.length === 5, `分区数应为 5，实际 ${state.state.schema.sections.length}`);
  check(state.state.schema.presets.length >= 8, '缺少服务商预设');
  check(state.state.schema.providerDefaults.ollama, '缺少各服务商默认值');

  // 4) 把 state 灌进页面，验证渲染
  const push = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
  push(state);

  const navItems = doc.querySelectorAll('#nav .nav-item');
  check(navItems.length === 5, `导航应有 5 项，实际 ${navItems.length}`);
  const navText = [...navItems].map((n) => n.textContent).join('|');
  for (const label of ['模型服务', '提交信息', '代码审查', '上下文与隐私', '高级']) {
    check(navText.includes(label), `导航缺少「${label}」`);
  }
  check(doc.querySelectorAll('#content .card').length >= 8, '服务商卡片没有渲染');
  check(
    doc.querySelectorAll('#content .card .c-ico svg').length >= 8,
    '服务商卡片缺少品牌图标',
  );
  check(doc.querySelector('#content .adv') !== null, '缺少「更多选项」折叠区');
  check(doc.querySelector('#key-input') !== null, '模型区缺少密钥输入框');
  check(doc.querySelector('#btn-test') !== null, '模型区缺少测试连接按钮');
  check(doc.querySelector('#health').className.includes('warn'), '未配置密钥时横幅应为警告态');

  // 5) 点服务商卡片 → 填地址与模型 → 保存
  const cards = [...doc.querySelectorAll('#content .card')];
  const deepseek = cards.find((c) => c.textContent.includes('DeepSeek'));
  check(Boolean(deepseek), '找不到 DeepSeek 卡片');
  if (deepseek) {
    deepseek.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  const modelInput = doc.querySelector('#content input[data-key="commitCraft.model"]');
  check(modelInput && modelInput.value === 'deepseek-chat', `选卡片后模型应回填，实际 ${modelInput && modelInput.value}`);
  const urlInput = doc.querySelector('#content input[data-key="commitCraft.baseUrl"]');
  check(
    urlInput && urlInput.value === 'https://api.deepseek.com/v1',
    `选卡片后地址应回填，实际 ${urlInput && urlInput.value}`,
  );

  const saveBtn = doc.querySelector('#btn-save');
  check(!saveBtn.disabled, '有改动时保存按钮应可用');
  check(doc.querySelector('#dirty').textContent.includes('未保存'), '没有显示未保存提示');

  saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const saveMsg = posted.filter((m) => m.type === 'save').pop();
  check(Boolean(saveMsg), '点击保存没有发出 save 消息');
  if (saveMsg) {
    check(saveMsg.values['commitCraft.provider'] === 'openai-compatible', 'provider 未带在保存内容里');
    check(saveMsg.values['commitCraft.model'] === 'deepseek-chat', 'model 未带在保存内容里');
    await messageHandler(saveMsg);
    const savedModel = updateCalls.find((c) => c.key === 'model');
    const savedUrl = updateCalls.find((c) => c.key === 'baseUrl');
    check(Boolean(savedModel && savedModel.value === 'deepseek-chat'), 'model 没有写入配置');
    check(Boolean(savedUrl && savedUrl.value === 'https://api.deepseek.com/v1'), 'baseUrl 没有写入配置');
    // provider 与原来相同（都是 openai-compatible），不该产生多余的写入
    check(!updateCalls.some((c) => c.key === 'provider'), '未变化的项也被写入了配置');
    check(savedModel && savedModel.value === configStore.model, '写入的值与配置存储不一致');
    check(updateCalls.every((c) => c.target === 1), '写配置没有走全局作用域');
  }

  const savedMsg = posted.filter((m) => m.type === 'saved').pop();
  check(Boolean(savedMsg), '宿主没有回 saved');
  if (savedMsg) {
    push(savedMsg);
    check(doc.querySelector('#btn-save').disabled, '保存成功后按钮应回到禁用');
    check(!doc.querySelector('#dirty').textContent.includes('未保存'), '保存后仍显示未保存');
  }

  // 6) 非法值不落盘
  const before = updateCalls.length;
  await messageHandler({
    type: 'save',
    values: { 'commitCraft.requestTimeoutMs': 100, 'commitCraft.temperature': 0.3 },
  });
  check(updateCalls.length === before, '非法配置不应写入 settings.json');
  const failed = posted.filter((m) => m.type === 'saveFailed').pop();
  check(Boolean(failed), '非法配置没有回 saveFailed');
  check(failed && failed.errors.some((e) => e.includes('requestTimeoutMs')), '错误信息没有指出具体项');

  // 7) 密钥：保存 → 掩码可见 → 清除
  await messageHandler({ type: 'saveKey', provider: 'openai-compatible', key: 'sk-deepseek-abcdefg1234' });
  check(secretStore.get('commitCraft.apiKey.openai-compatible') === 'sk-deepseek-abcdefg1234', '密钥没有写入凭据库');
  check(
    !updateCalls.some((c) => /apiKey/i.test(c.key)),
    '密钥绝不能出现在 settings.json 的写入里',
  );
  const keyState = posted.filter((m) => m.type === 'keyState').pop();
  check(Boolean(keyState && keyState.key.hasKey), '没有回传密钥状态');
  check(keyState && /^sk-/.test(keyState.key.masked) && keyState.key.masked.includes('•'), '密钥掩码不正确');
  check(keyState && !keyState.key.masked.includes('deepseek-a'), '掩码泄露了密钥中段');

  await messageHandler({ type: 'saveKey', provider: 'openai-compatible', key: 'short' });
  check(secretStore.get('commitCraft.apiKey.openai-compatible') === 'sk-deepseek-abcdefg1234', '过短的密钥被接受了');

  await messageHandler({ type: 'clearKey', provider: 'openai-compatible' });
  check(!secretStore.get('commitCraft.apiKey.openai-compatible'), '清除密钥没生效');

  // 8) 获取模型列表
  await messageHandler({ type: 'fetchModels', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' });
  const modelsMsg = posted.filter((m) => m.type === 'models').pop();
  check(Boolean(modelsMsg && modelsMsg.models.length === 4), '模型列表没有回传');
  check(
    modelsMsg && modelsMsg.models[modelsMsg.models.length - 1].id === 'text-embedding-3-small',
    `embedding 模型应排在最后，实际 ${modelsMsg && modelsMsg.models[modelsMsg.models.length - 1].id}`,
  );
  check(
    modelsMsg && modelsMsg.models[0].id !== 'text-embedding-3-small',
    'embedding 模型不该排在最前',
  );
  check(requests.some((r) => r.url.endsWith('/models')), '没有请求 /models');

  /*
   * 下拉必须是「点得开、选得中」的真列表。
   * 之前用 <input list> + <datalist>，webview 里既没有箭头也点不出来，
   * 表现就是「获取模型之后没法选」，所以这几条断言专门守这个回归。
   */
  if (modelsMsg) {
    push(modelsMsg);
    const pop = doc.querySelector('#model-pop');
    check(Boolean(pop), '获取模型后没有渲染下拉列表');
    check(Boolean(pop && !pop.hasAttribute('hidden')), '获取模型后下拉应自动展开');
    check(doc.querySelector('#btn-model-toggle') !== null, '模型输入框缺少下拉按钮');
    const items = [...doc.querySelectorAll('#model-pop .combo-item')];
    check(items.length === 4, `下拉项应为 4 个，实际 ${items.length}`);
    const pick = items.find((i) => i.dataset.model === 'deepseek-reasoner');
    check(Boolean(pick), '下拉里找不到 deepseek-reasoner');
    if (pick) {
      pick.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      const input2 = doc.querySelector('#model-input');
      check(
        input2 && input2.value === 'deepseek-reasoner',
        `点击下拉项后模型应为 deepseek-reasoner，实际 ${input2 && input2.value}`,
      );
      check(doc.querySelector('#model-pop').hasAttribute('hidden'), '选中后下拉应收起');
      check(doc.querySelector('#dirty').textContent.includes('未保存'), '选中模型后应标记为未保存');
    }
    // 过滤：输入框里打字应筛掉不匹配项
    doc.querySelector('#btn-model-toggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const input3 = doc.querySelector('#model-input');
    input3.value = 'coder';
    input3.dispatchEvent(new window.Event('input', { bubbles: true }));
    const visible = [...doc.querySelectorAll('#model-pop .combo-item')].filter((el) => !el.hidden);
    check(visible.length === 1 && visible[0].dataset.model === 'deepseek-coder', '下拉没有按输入内容过滤');
    input3.value = 'deepseek-reasoner';
    input3.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  // 原生下拉在各平台长得不一样，必须统一套 .select-wrap（自绘箭头）
  const selects = [...doc.querySelectorAll('#content select')];
  check(selects.length > 0, '页面上没有渲染下拉框');
  check(
    selects.every((s) => s.parentElement.classList.contains('select-wrap')),
    '有下拉框没有套自绘箭头容器',
  );
  check(/select\s*\{[^}]*appearance:\s*none/.test(html), '下拉框没有重置原生外观');
  check(!/\.panel\s*\{[^}]*overflow:\s*hidden/.test(html), '面板的 overflow:hidden 会把模型下拉裁掉');

  // 9) 测试连接
  await messageHandler({
    type: 'test',
    values: { 'commitCraft.provider': 'openai-compatible', 'commitCraft.baseUrl': 'https://api.deepseek.com/v1', 'commitCraft.model': 'deepseek-chat' },
    key: 'sk-test-1234567890',
  });
  const testMsg = posted.filter((m) => m.type === 'testResult').pop();
  check(Boolean(testMsg && testMsg.ok), `连接测试失败：${testMsg && testMsg.message}`);
  check(testMsg && testMsg.message.includes('deepseek-chat'), '连接结果没有说明用了哪个模型');

  // 10) 恢复本页默认
  const beforeReset = updateCalls.length;
  await messageHandler({ type: 'resetSection', section: 'commit', keys: ['commitCraft.commit.format', 'commitCraft.commit.maxSubjectLength'] });
  check(updateCalls.length - beforeReset === 2, '恢复默认应写入两项');
  check(configStore['commit.format'] === 'conventional', '恢复默认值不对');

  // 11) 原生设置入口
  await messageHandler({ type: 'openNative' });
  check(
    executed.some((e) => e.id === 'commitCraft.openNativeSettings'),
    '没有转发到原生设置命令',
  );
  // 过滤器必须用扩展真实 ID，否则设置页搜不到本扩展的设置项
  const nativeOpen = executed.filter((e) => e.id === 'workbench.action.openSettings').pop();
  check(
    Boolean(nativeOpen) && String(nativeOpen.args[0]).includes('@ext:miaosha-ikio.commitwise'),
    `原生设置过滤器不对：${nativeOpen && nativeOpen.args[0]}`,
  );

  // 12) 搜索：过滤出跨分区的字段
  const search = doc.querySelector('#search');
  search.value = '超时';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const contentText = doc.querySelector('#content').textContent;
  check(contentText.includes('请求超时'), '搜索没有命中「请求超时」');
  check(!contentText.includes('提示词模板'), '搜索结果混入了不相关字段');
  check(doc.querySelector('#nav .nav-item.active') === null, '搜索状态下导航不该再高亮某个分区');
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));

  // 13) 工作区级配置覆盖时给出提示，而不是让用户以为保存没生效
  workspaceValues.model = 'team-fixed-model';
  await messageHandler({ type: 'ready' });
  push(posted.filter((m) => m.type === 'state').pop());
  check(
    doc.querySelector('#health').textContent.includes('被工作区别的配置覆盖'),
    '工作区覆盖时没有提示',
  );

  if (process.argv.includes('--preview')) {
    writePreview(html, state);
  }

  finish();

  function finish() {
    if (failures.length > 0) {
      console.error('设置页端到端验证失败：');
      for (const f of failures) console.error('  - ' + f);
      process.exit(1);
    }
    console.log(
      '设置页端到端验证通过：' +
        '面板创建 → webview 脚本执行 → 5 个分区渲染 → 点卡片回填 → 保存落盘 → ' +
        '非法值拦截 → 密钥掩码与清除 → 获取模型 → 测试连接 → 恢复默认 → 搜索过滤 → 工作区覆盖提示',
    );
  }
})();

/* ------------------------------------------------------------ 静态预览 */

/**
 * 把面板 HTML + 一份真实 state 压成一个可以脱离 VSCode 打开的静态页。
 * 用途：评审 UI、录截图、给别人看，不用先装扩展。
 * 通过 `node scripts/e2e-settings.js --preview` 生成到 preview/settings-page.html。
 */
function writePreview(rawHtml, stateMsg) {
  // 预览页跟随系统深浅色：VSCode 会把 --vscode-* 注入 webview，脱离编辑器就得自己给一套
  const darkVars = `  --vscode-font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Cascadia Mono", monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818;
  --vscode-panel-border: #2b2b2b;
  --vscode-descriptionForeground: #9da0a4;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-focusBorder: #0078d4;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8;
  --vscode-textBlockQuote-background: #262626;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-editorError-foreground: #f14c4c;
  --vscode-testing-iconPassed: #73c991;
  --vscode-notifications-background: #202020;
  --vscode-notifications-foreground: #cccccc;
  --vscode-notifications-border: #2b2b2b;
  --vscode-toolbar-hoverBackground: rgba(90,93,94,.31);
  --vscode-inputValidation-errorBackground: rgba(90,18,20,.5);
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-editorWidget-background: #202020;`;

  const lightVars = `  --vscode-foreground: #3b3b3b;
  --vscode-editor-background: #ffffff;
  --vscode-sideBar-background: #f8f8f8;
  --vscode-panel-border: #e5e5e5;
  --vscode-descriptionForeground: #717171;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #3b3b3b;
  --vscode-input-border: #cecece;
  --vscode-focusBorder: #0090f1;
  --vscode-button-background: #005fb8;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0258a8;
  --vscode-button-secondaryBackground: #e5e5e5;
  --vscode-button-secondaryForeground: #3b3b3b;
  --vscode-button-secondaryHoverBackground: #d9d9d9;
  --vscode-list-hoverBackground: #f2f2f2;
  --vscode-list-activeSelectionBackground: #e4e6f1;
  --vscode-list-activeSelectionForeground: #000000;
  --vscode-badge-background: #cccccc;
  --vscode-badge-foreground: #3b3b3b;
  --vscode-textBlockQuote-background: #f3f3f3;
  --vscode-editorWarning-foreground: #bf8803;
  --vscode-editorError-foreground: #e51400;
  --vscode-testing-iconPassed: #388a34;
  --vscode-notifications-background: #ffffff;
  --vscode-notifications-foreground: #3b3b3b;
  --vscode-notifications-border: #e5e5e5;
  --vscode-toolbar-hoverBackground: rgba(90,93,94,.12);
  --vscode-inputValidation-errorBackground: rgba(229,20,0,.08);
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-editorWidget-background: #ffffff;`;

  const theme = `:root{
${darkVars}
}
@media (prefers-color-scheme: light) {
  :root {
${lightVars}
  }
}
body { margin: 0; }
.preview-note {
  font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-descriptionForeground);
  background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 18px;
}
.app { height: calc(100vh - 29px); }
`;

  const state = JSON.parse(JSON.stringify(stateMsg));
  // 预览用一份「已配置好 DeepSeek」的典型状态，比默认值更能反映实际观感
  state.state.values['commitCraft.baseUrl'] = 'https://api.deepseek.com/v1';
  state.state.values['commitCraft.model'] = 'deepseek-chat';
  state.state.meta.key = { hasKey: true, masked: 'sk-••••••1234', envName: '', envPresent: true };
  state.state.meta.activePresetKey = 'deepseek';
  state.state.meta.models = [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-coder' }];
  state.state.health = {
    level: 'ok',
    title: 'deepseek-chat 已就绪',
    detail: '密钥已保存在凭据库；接口地址与所选服务商匹配。',
  };
  const stateJson = JSON.stringify(state).replace(/</g, '\\u003c');

  const shim = `<script>
window.acquireVsCodeApi = function () {
  var current = JSON.parse(${JSON.stringify(stateJson)});
  var reply = function (o) {
    setTimeout(function () { window.dispatchEvent(new MessageEvent('message', { data: o })); }, 60);
  };
  return {
    postMessage: function (m) {
      if (m.type === 'ready') {
        setTimeout(function () { window.dispatchEvent(new MessageEvent('message', { data: current })); }, 0);
        return;
      }
      if (m.type === 'save') {
        current.state.values = Object.assign({}, current.state.values, m.values);
        var model = current.state.values['commitCraft.model'];
        current.state.health = { level: 'ok', title: model + ' 已就绪', detail: '配置校验通过。' };
        reply({ type: 'saved', state: current.state, changed: Object.keys(m.values).length });
      } else if (m.type === 'test') {
        reply({ type: 'testRunning' });
        setTimeout(function () {
          reply({ type: 'testResult', ok: true, message: '连接成功 · 412ms · ' + (m.values['commitCraft.model'] || '') + ' · 响应「OK」' });
        }, 600);
      } else if (m.type === 'fetchModels') {
        reply({ type: 'modelsLoading' });
        setTimeout(function () {
          reply({ type: 'models', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-coder' }] });
        }, 700);
      } else if (m.type === 'saveKey') {
        current.state.meta.key = { hasKey: true, masked: 'sk-••••••' + String(m.key).slice(-4), envName: '', envPresent: false };
        reply({ type: 'keyState', provider: m.provider, key: current.state.meta.key });
        reply({ type: 'toast', level: 'ok', message: '预览模式：密钥未真实保存' });
      } else if (m.type === 'clearKey') {
        current.state.meta.key = { hasKey: false, envName: '', envPresent: false };
        reply({ type: 'keyState', provider: m.provider, key: current.state.meta.key });
      } else if (m.type === 'queryKey') {
        reply({ type: 'keyState', provider: m.provider, key: current.state.meta.key });
      } else if (m.type === 'resetSection') {
        reply({ type: 'toast', level: 'warn', message: '预览模式不支持恢复默认' });
      } else if (m.type === 'openNative') {
        reply({ type: 'toast', level: 'warn', message: '预览模式：安装扩展后会打开原生设置界面' });
      }
    },
  };
};
</script>`;

  const body = rawHtml
    .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>\s*/, '')
    .replace('</head>', `<style>${theme}</style>\n</head>`)
    .replace(
      '<body>',
      '<body>\n<div class="preview-note">静态预览 · 交互为本地模拟，「保存」不会写入任何配置</div>',
    )
    .replace(/(<script nonce="[^"]*">)/, shim + '$1')
    .replace(/src="[^"]*icon\.png"/, 'src="../media/icon.png"');

  const outPath = path.join(__dirname, '..', 'preview', 'settings-page.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body, 'utf8');
  console.log('已生成静态预览：' + outPath);
}
