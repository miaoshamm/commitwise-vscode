import { RawConfig } from './configTypes';
import { PROVIDER_IDS, PROVIDER_LABELS } from './providers';

/**
 * 设置页的数据模型。
 *
 * 这里只描述「有哪些设置、怎么分组、怎么展示」，不读 vscode API，
 * 因此扁平化 / 反解 / 变更对比 / 默认值回填都能在纯 Node 下单测。
 * 真正的读写发生在 `ui/settingsPanel.ts` 里，走 `workspace.getConfiguration`。
 */

export const SECTION = 'commitCraft';

export type FieldType = 'text' | 'number' | 'boolean' | 'select' | 'list';

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface SettingsField {
  /** 完整键名，例如 `commitCraft.commit.format` */
  key: string;
  label: string;
  type: FieldType;
  description?: string;
  placeholder?: string;
  options?: FieldOption[];
  /** 选项由宿主运行时注入（内置 + 自定义模板，数量随用户配置变化） */
  optionsFrom?: 'commitTemplates' | 'reviewTemplates';
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** 影响成本或效果，UI 上单独提示 */
  caution?: string;
}

export interface SettingsSection {
  id: string;
  label: string;
  tagline: string;
  /** 由 webview 内部映射为内联 SVG，避免打包字体 */
  icon: 'model' | 'commit' | 'review' | 'context' | 'advanced';
  /** true 表示该分区由专用 UI 渲染，不用通用表单 */
  custom?: 'model';
  fields: SettingsField[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'model',
    label: '模型服务',
    tagline: '决定把代码发给谁、用哪个模型',
    icon: 'model',
    custom: 'model',
    fields: [
      {
        key: `${SECTION}.provider`,
        label: '服务商类型',
        type: 'select',
        description: '决定请求格式与鉴权方式',
        options: PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] })),
      },
      {
        key: `${SECTION}.baseUrl`,
        label: '接口地址',
        type: 'text',
        description: '一般以 /v1 结尾；已填到 /chat/completions 时按原样使用',
        placeholder: 'https://api.deepseek.com/v1',
      },
      {
        key: `${SECTION}.model`,
        label: '默认模型',
        type: 'text',
        description: '留空则使用服务商推荐模型（Azure 必须显式填写 deployment 名称）',
        placeholder: 'deepseek-chat',
      },
      {
        key: `${SECTION}.autoFetchModels`,
        label: '自动获取模型列表',
        type: 'boolean',
        description: '打开设置页与首次选模型时请求 /models。内网环境可关闭，改为手动填写',
      },
      {
        key: `${SECTION}.availableModels`,
        label: '额外候选模型',
        type: 'list',
        description: '每行一个。用于接口不支持列表、或想固定几个常用模型的场景',
        placeholder: 'deepseek-chat\ndeepseek-reasoner',
      },
      {
        key: `${SECTION}.apiKeyEnv`,
        label: '密钥环境变量名',
        type: 'text',
        description: '填写后优先从该环境变量读取密钥（CI 场景有用），留空则只用凭据库',
        placeholder: 'DEEPSEEK_API_KEY',
      },
    ],
  },
  {
    id: 'commit',
    label: '提交信息',
    tagline: '生成结果的格式、语言与长度',
    icon: 'commit',
    fields: [
      {
        key: `${SECTION}.commit.format`,
        label: '提交格式',
        type: 'select',
        description: '决定标题的结构与允许的 type 前缀',
        options: [
          { value: 'conventional', label: 'Conventional Commits', description: 'feat / fix / refactor…，主流规范' },
          { value: 'angular', label: 'Angular 规范', description: '与 conventional 接近，type 集合更严格' },
          { value: 'gitmoji', label: 'Gitmoji', description: '用 emoji 表达变更类型' },
          { value: 'plain', label: '纯文本', description: '只写一句话，不加前缀' },
          { value: 'custom', label: '自定义', description: '完全由模板决定，不做格式校验' },
        ],
      },
      {
        key: `${SECTION}.commit.language`,
        label: '描述语言',
        type: 'select',
        description: '跟随编辑器语言时，VSCode 是中文界面就写中文',
        options: [
          { value: 'auto', label: '跟随编辑器' },
          { value: 'zh-CN', label: '简体中文' },
          { value: 'en', label: 'English' },
        ],
      },
      {
        key: `${SECTION}.commit.templateId`,
        label: '提示词模板',
        type: 'select',
        optionsFrom: 'commitTemplates',
        description: '模板决定提示词的组织方式，与上面的「格式」是两件事',
      },
      {
        key: `${SECTION}.commit.maxSubjectLength`,
        label: '标题长度上限',
        type: 'number',
        min: 20,
        max: 200,
        step: 2,
        suffix: '字符',
        description: '超出时会在提示词里要求模型压缩',
      },
      {
        key: `${SECTION}.commit.includeBody`,
        label: '生成正文',
        type: 'boolean',
        description: '关闭后只写一行标题，适合改动很小的提交',
      },
      {
        key: `${SECTION}.commit.recentCommitCount`,
        label: '参考历史提交',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
        suffix: '条',
        description: '取最近几条提交的标题作为风格参考。设为 0 则不发，可省一点 token',
      },
      {
        key: `${SECTION}.commit.confirmBeforeInsert`,
        label: '写入前先确认',
        type: 'boolean',
        description: '弹出输入框让你改一遍再写入源代码管理输入框',
      },
    ],
  },
  {
    id: 'review',
    label: '代码审查',
    tagline: '审什么、报多少、怎么显示',
    icon: 'review',
    fields: [
      {
        key: `${SECTION}.review.templateId`,
        label: '审查模板',
        type: 'select',
        optionsFrom: 'reviewTemplates',
        description: '标准模板看缺陷与可维护性，安全模板专盯注入、鉴权与密钥泄露',
      },
      {
        key: `${SECTION}.review.minSeverity`,
        label: '最低报告级别',
        type: 'select',
        description: '提高门槛可减少噪音，但低危的改进建议也会被过滤',
        options: [
          { value: 'high', label: '只看高危' },
          { value: 'medium', label: '中危及以上' },
          { value: 'low', label: '全部（含建议）' },
        ],
      },
      {
        key: `${SECTION}.review.maxIssues`,
        label: '最多报告条数',
        type: 'number',
        min: 5,
        max: 100,
        step: 5,
        suffix: '条',
        description: '结果按严重程度排序后截断，超出的部分会在报告里注明',
      },
      {
        key: `${SECTION}.review.showDiagnostics`,
        label: '在编辑器标注问题',
        type: 'boolean',
        description: '把问题画成波浪线。只想看报告不想要标记时可以关掉',
      },
    ],
  },
  {
    id: 'context',
    label: '上下文与隐私',
    tagline: '哪些文件会被发出去',
    icon: 'context',
    fields: [
      {
        key: `${SECTION}.diff.maxTotalChars`,
        label: '单次总字符上限',
        type: 'number',
        min: 4000,
        max: 200000,
        step: 1000,
        suffix: '字符',
        description: '超出后先整文件丢弃、再截断单文件。约 4 字符 ≈ 1 token',
      },
      {
        key: `${SECTION}.diff.maxFileChars`,
        label: '单文件字符上限',
        type: 'number',
        min: 1000,
        max: 60000,
        step: 1000,
        suffix: '字符',
        description: '单个文件改动过大时只保留前面部分，并在提示词里标明被截断',
      },
      {
        key: `${SECTION}.diff.excludeGlobs`,
        label: '排除的文件',
        type: 'list',
        description: '每行一个 glob。命中的文件不发送内容，只在文件清单里列出名字',
        placeholder: '**/package-lock.json\n**/dist/**',
      },
      {
        key: `${SECTION}.diff.redactSecrets`,
        label: '脱敏疑似密钥',
        type: 'boolean',
        description: '发送前把 openai key、私钥、token 之类的字面量替换为掩码',
        caution: '建议保持开启，避免把真实凭据发给模型服务商',
      },
    ],
  },
  {
    id: 'advanced',
    label: '高级',
    tagline: '采样参数与网络行为，一般不用改',
    icon: 'advanced',
    fields: [
      {
        key: `${SECTION}.temperature`,
        label: 'temperature',
        type: 'number',
        min: 0,
        max: 2,
        step: 0.1,
        description: '写提交信息建议 0.1–0.3，太高会出现发挥性描述',
      },
      {
        key: `${SECTION}.maxTokens`,
        label: 'maxTokens',
        type: 'number',
        min: 128,
        max: 16000,
        step: 128,
        description: '单次响应的 token 上限。审查模式比生成模式需要更多',
      },
      {
        key: `${SECTION}.requestTimeoutMs`,
        label: '请求超时',
        type: 'number',
        min: 5000,
        max: 300000,
        step: 5000,
        suffix: '毫秒',
        description: '本地大模型首次加载较慢，可以适当调大',
      },
      {
        key: `${SECTION}.maxRetries`,
        label: '失败重试次数',
        type: 'number',
        min: 0,
        max: 5,
        step: 1,
        suffix: '次',
        description: '仅对 429 / 5xx / 网络错误重试，已输出内容后不再重试',
      },
    ],
  },
];

/** 不在设置页编辑的键（自定义模板是结构化对象，交给设置页之外的手段维护） */
const NON_EDITABLE = new Set([`${SECTION}.customTemplates`]);

/** 把嵌套的 RawConfig 摊平成 `commitCraft.a.b -> value` */
export function flattenRaw(raw: RawConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        out[`${SECTION}.${key}.${inner}`] = innerValue;
      }
    } else {
      out[`${SECTION}.${key}`] = value;
    }
  }
  for (const key of NON_EDITABLE) {
    delete out[key];
  }
  return out;
}

/** 按基值类型强制转换。webview 传来的值可能是字符串，不能直接落盘 */
export function coerceLike(value: unknown, sample: unknown): unknown {
  if (typeof sample === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    return Number.isFinite(n) ? n : sample;
  }
  if (typeof sample === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    return String(value).trim().toLowerCase() === 'true';
  }
  if (Array.isArray(sample)) {
    if (Array.isArray(value)) {
      const hasObject = value.some((v) => v !== null && typeof v === 'object');
      return hasObject ? value : value.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return sample;
  }
  if (value === null || value === undefined) {
    return sample;
  }
  return String(value);
}

/**
 * 把一批 `commitCraft.*` 值套到 RawConfig 上，返回新对象。
 * 未识别的键直接忽略——设置页永远不能凭空造出配置项。
 */
export function applyValues(base: RawConfig, values: Record<string, unknown>): RawConfig {
  const out: RawConfig = JSON.parse(JSON.stringify(base));
  for (const [fullKey, incoming] of Object.entries(values)) {
    if (NON_EDITABLE.has(fullKey)) {
      continue;
    }
    const parts = fullKey.split('.').slice(1);
    if (parts.length === 0) {
      continue;
    }
    let cursor: Record<string, unknown> = out as unknown as Record<string, unknown>;
    let alive = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cursor[parts[i]];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        alive = false;
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    if (!alive) {
      continue;
    }
    const leaf = parts[parts.length - 1];
    if (!(leaf in cursor)) {
      continue;
    }
    cursor[leaf] = coerceLike(incoming, cursor[leaf]);
  }
  return out;
}

/** 两次扁平化结果之间变化的键。数组按内容比较，避免顺序相同却判为变化 */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diff.push(key);
    }
  }
  return diff;
}

/** 供 webview 展示的密钥掩码：保留很少信息，只用于让用户确认「填过哪一把」 */
export function maskSecret(value: string | undefined): string | undefined {
  const secret = (value ?? '').trim();
  if (!secret) {
    return undefined;
  }
  if (secret.length <= 10) {
    return '•'.repeat(secret.length);
  }
  return `${secret.slice(0, 3)}${'•'.repeat(6)}${secret.slice(-4)}`;
}

/** 设置页顶部的健康状态，决定横幅显示什么 */
export interface ConfigHealth {
  level: 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
}

export function describeHealth(input: {
  errors: string[];
  warnings: string[];
  provider: string;
  model: string;
  hasKey: boolean;
  requiresKey: boolean;
  envName?: string;
  envPresent: boolean;
}): ConfigHealth {
  if (input.errors.length > 0) {
    return { level: 'error', title: '配置存在错误，暂时无法调用模型', detail: input.errors[0] };
  }
  if (input.requiresKey && !input.hasKey && !(input.envName && input.envPresent)) {
    return {
      level: 'warn',
      title: '尚未保存 API 密钥',
      detail: input.envName
        ? `环境变量 ${input.envName} 当前也未读到值`
        : '填好密钥后即可生成提交信息与审查代码',
    };
  }
  const warning = input.warnings.find((w) => !w.includes('推荐默认模型'));
  if (warning) {
    return { level: 'warn', title: '可以运行，但有一处需要留意', detail: warning };
  }
  const defaulted = input.warnings.find((w) => w.includes('推荐默认模型'));
  if (defaulted) {
    return {
      level: 'ok',
      title: `${input.model} 可用`,
      detail: `没有显式设置模型，正在使用推荐默认值。想固定下来就在下方填上 ${input.model}`,
    };
  }
  return { level: 'ok', title: `${input.model} 已就绪`, detail: undefined };
}
