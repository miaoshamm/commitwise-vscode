import { ProviderId, PROVIDER_IDS } from './providers';

export interface ModelSuggestion {
  id: string;
  note: string;
}

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** 官方默认接口地址，空串表示必须由用户填写 */
  baseUrl: string;
  /** 未显式配置模型时使用的推荐默认模型 */
  defaultModel: string;
  requiresApiKey: boolean;
  supportsModelList: boolean;
  /** 填写模型时的提示文案 */
  modelHint: string;
  /** 填写接口地址时的提示文案 */
  urlHint: string;
  suggestions: ModelSuggestion[];
}

/**
 * 各服务商的默认值。目标是：用户只填密钥也能跑起来（model 留空时回填 defaultModel）。
 * 推荐模型仅用于「选择模型」列表的排序与标注，实际可用模型以接口返回为准。
 */
export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI 兼容接口',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresApiKey: true,
    supportsModelList: true,
    modelHint: 'OpenAI 官方或兼容网关的模型名，例如 gpt-4o-mini、deepseek-chat、qwen-plus',
    urlHint: '兼容接口通常以 /v1 结尾，例如 https://api.openai.com/v1、https://api.deepseek.com/v1',
    suggestions: [
      { id: 'gpt-4o-mini', note: 'OpenAI · 便宜快速，够用' },
      { id: 'gpt-4o', note: 'OpenAI · 质量更高' },
      { id: 'deepseek-chat', note: 'DeepSeek · 需把地址改为 api.deepseek.com/v1' },
      { id: 'qwen-plus', note: '阿里云百炼 · 需改为 dashscope 兼容地址' },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-haiku-latest',
    requiresApiKey: true,
    supportsModelList: true,
    modelHint: 'Claude 模型名，例如 claude-3-5-haiku-latest、claude-3-5-sonnet-latest',
    urlHint: '官方地址为 https://api.anthropic.com/v1',
    suggestions: [
      { id: 'claude-3-5-haiku-latest', note: '快且便宜，适合写提交信息' },
      { id: 'claude-3-5-sonnet-latest', note: '审查质量更好' },
    ],
  },
  'azure-openai': {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    baseUrl: '',
    defaultModel: '',
    requiresApiKey: true,
    supportsModelList: false,
    modelHint: '填 Azure 上的 deployment 名称（不是底层模型名）',
    urlHint: '填资源地址 + /openai，例如 https://<资源名>.openai.azure.com/openai',
    suggestions: [],
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5-coder:7b',
    requiresApiKey: false,
    supportsModelList: true,
    modelHint: '本地已 pull 的模型名，可用 ollama list 查看',
    urlHint: 'Ollama 默认监听 http://localhost:11434，不要带 /api',
    suggestions: [
      { id: 'qwen2.5-coder:7b', note: '代码场景推荐，7B 显存友好' },
      { id: 'deepseek-coder-v2:16b', note: '效果更好，需要更大显存' },
      { id: 'llama3.1:8b', note: '通用对话' },
    ],
  },
};

export function presetOf(provider: string): ProviderPreset {
  const id = (PROVIDER_IDS as readonly string[]).includes(provider) ? (provider as ProviderId) : 'openai-compatible';
  return PROVIDER_PRESETS[id];
}

/**
 * 「开箱即用」入口：把常见的服务商/网关连地址和默认模型一起准备好，
 * 用户只需要选一项 + 填密钥，不用自己查接口地址。
 */
export interface EndpointPreset {
  key: string;
  label: string;
  description: string;
  provider: ProviderId;
  baseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
  /** 申请密钥的说明 */
  keyHint: string;
}

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    description: '国内直连 · 性价比高',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    keyHint: '在 platform.deepseek.com 的「API keys」页面创建',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    description: '需要外网访问',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresApiKey: true,
    keyHint: '在 platform.openai.com 的「API keys」页面创建',
  },
  {
    key: 'qwen',
    label: '阿里云百炼',
    description: '通义千问 · 兼容模式',
    provider: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    requiresApiKey: true,
    keyHint: '在百炼控制台的「API-KEY 管理」创建',
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    description: 'Kimi · 国内直连',
    provider: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    requiresApiKey: true,
    keyHint: '在 platform.moonshot.cn 的「API Key 管理」创建',
  },
  {
    key: 'zhipu',
    label: '智谱 GLM',
    description: 'GLM · 国内直连',
    provider: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    requiresApiKey: true,
    keyHint: '在 bigmodel.cn 的「API Keys」页面创建',
  },
  {
    key: 'ollama',
    label: 'Ollama 本地',
    description: '完全离线 · 无需密钥',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5-coder:7b',
    requiresApiKey: false,
    keyHint: '',
  },
  {
    key: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Claude · 需要外网',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-haiku-latest',
    requiresApiKey: true,
    keyHint: '在 console.anthropic.com 的「API Keys」页面创建',
  },
  {
    key: 'azure',
    label: 'Azure OpenAI',
    description: '企业内网 / 合规场景',
    provider: 'azure-openai',
    baseUrl: '',
    defaultModel: '',
    requiresApiKey: true,
    keyHint: '在 Azure 门户的「密钥和终结点」页面获取',
  },
];

/** 根据当前配置反查出对应的入口预设，用于在设置向导里标注「当前」 */
export function matchEndpointPreset(provider: string, baseUrl: string): EndpointPreset | undefined {
  const normalized = (baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return ENDPOINT_PRESETS.find(
    (p) => p.provider === provider && p.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized,
  );
}

/** 判断接口地址是否与所选服务商明显不匹配，用于给出配置提示 */
export function detectConfigMismatch(provider: string, baseUrl: string): string | undefined {
  const lower = (baseUrl ?? '').toLowerCase();
  if (!lower) {
    return undefined;
  }
  if (provider === 'ollama' && !/localhost|127\.0\.0\.1|\[::1\]|:11434/.test(lower)) {
    return `当前服务商是 Ollama，但接口地址是 ${baseUrl}。Ollama 是本地服务，通常应填 http://localhost:11434`;
  }
  if (provider === 'azure-openai' && !lower.includes('.openai.azure.com')) {
    return `Azure OpenAI 的接口地址应形如 https://<资源名>.openai.azure.com/openai，当前为 ${baseUrl}`;
  }
  if (provider === 'openai-compatible' && lower.includes('.openai.azure.com')) {
    return '这是 Azure OpenAI 的地址，请把服务商切换为「Azure OpenAI」';
  }
  if (provider === 'openai-compatible' && lower.includes('anthropic.com')) {
    return '这是 Anthropic 的地址，请把服务商切换为「Anthropic Claude」';
  }
  if (provider === 'anthropic' && !lower.includes('anthropic')) {
    return `当前服务商是 Anthropic，但接口地址不是 Anthropic 官方地址：${baseUrl}`;
  }
  return undefined;
}
