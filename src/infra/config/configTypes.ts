import { CommitFormat } from '../../domain/commit/messageValidator';
import { PromptTemplate } from '../../domain/prompt/renderTemplate';
import { Severity } from '../../domain/review/reviewIssue';
import { detectConfigMismatch, matchEndpointPreset, presetOf } from './providerPresets';
import { isProviderId, ProviderId, PROVIDER_IDS, PROVIDER_LABELS } from './providers';

export { isProviderId, PROVIDER_IDS, PROVIDER_LABELS };
export type { ProviderId };

export interface RawConfig {
  provider: string;
  baseUrl: string;
  model: string;
  autoFetchModels: boolean;
  availableModels: string[];
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
  apiKeyEnv: string;
  commit: {
    format: string;
    language: string;
    templateId: string;
    maxSubjectLength: number;
    includeBody: boolean;
    recentCommitCount: number;
    confirmBeforeInsert: boolean;
  };
  diff: {
    maxTotalChars: number;
    maxFileChars: number;
    excludeGlobs: string[];
    redactSecrets: boolean;
  };
  review: {
    templateId: string;
    minSeverity: string;
    maxIssues: number;
    showDiagnostics: boolean;
  };
  customTemplates: Partial<PromptTemplate>[];
}

export interface ResolvedConfig {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  autoFetchModels: boolean;
  availableModels: string[];
  apiKey?: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
  apiKeyEnv: string;
  language: 'zh-CN' | 'en';
  commit: {
    format: CommitFormat;
    language: 'zh-CN' | 'en';
    templateId: string;
    maxSubjectLength: number;
    includeBody: boolean;
    recentCommitCount: number;
    confirmBeforeInsert: boolean;
  };
  diff: {
    maxTotalChars: number;
    maxFileChars: number;
    excludeGlobs: string[];
    redactSecrets: boolean;
  };
  review: {
    templateId: string;
    minSeverity: Severity;
    maxIssues: number;
    showDiagnostics: boolean;
  };
  customTemplates: Partial<PromptTemplate>[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  /** 模型名称留空时自动回填的推荐模型，用于提示用户 */
  modelDefaulted?: string;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === '0.0.0.0';
}

export function resolveLanguage(raw: string, vscodeLanguage: string): 'zh-CN' | 'en' {
  if (raw === 'zh-CN' || raw === 'en') {
    return raw;
  }
  return vscodeLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function languageName(lang: 'zh-CN' | 'en'): string {
  return lang === 'zh-CN' ? '简体中文' : 'English';
}

/**
 * 校验配置并归一化。纯函数，方便单测；不读取任何 vscode API。
 */
export function validateConfig(raw: RawConfig, vscodeLanguage: string, apiKey?: string): ValidationResult & { config?: ResolvedConfig } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let modelDefaulted: string | undefined;

  const provider = raw.provider;
  if (!isProviderId(provider)) {
    errors.push(`未知的服务商类型 "${provider}"，可选值：${PROVIDER_IDS.join('、')}`);
  }
  const preset = presetOf(provider);

  const baseUrl = (raw.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    errors.push(
      provider === 'azure-openai'
        ? 'Azure OpenAI 需要填写接口地址（commitCraft.baseUrl），形如 https://<资源名>.openai.azure.com/openai'
        : '接口地址（commitCraft.baseUrl）不能为空',
    );
  } else {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        errors.push('接口地址必须以 http:// 或 https:// 开头');
      } else if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
        warnings.push(`接口地址使用明文 http，发送的代码内容可被中间人读取：${baseUrl}`);
      }
    } catch {
      errors.push(`接口地址不是合法的 URL：${baseUrl}`);
    }
  }

  const mismatch = detectConfigMismatch(provider, baseUrl);
  if (mismatch) {
    warnings.push(mismatch);
  }

  let model = (raw.model ?? '').trim();
  if (!model) {
    /*
     * 留空时的兜底模型要按「实际接口地址」选，而不是只看服务商类型：
     * DeepSeek 的地址走的是 openai-compatible 协议，但它的默认模型显然不该是 gpt-4o-mini。
     */
    const matched = matchEndpointPreset(provider, baseUrl);
    const fallback = matched?.defaultModel || preset.defaultModel;
    const fallbackLabel = matched?.label || preset.label;
    if (fallback) {
      model = fallback;
      modelDefaulted = fallback;
      warnings.push(`未设置模型（commitCraft.model），已使用 ${fallbackLabel} 的推荐默认模型 ${model}`);
    } else {
      errors.push(`请填写模型名称（commitCraft.model）。${preset.modelHint}`);
    }
  }

  const temperature = Number(raw.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    errors.push('temperature 必须在 0–2 之间');
  }

  if (!Number.isFinite(raw.maxTokens) || raw.maxTokens < 64) {
    errors.push('maxTokens 不能小于 64');
  }

  if (!Number.isFinite(raw.requestTimeoutMs) || raw.requestTimeoutMs < 5000) {
    errors.push('requestTimeoutMs 不能小于 5000');
  }

  if (provider !== 'ollama' && !apiKey) {
    if (raw.apiKeyEnv) {
      warnings.push(`未在密钥库中找到密钥，将尝试读取环境变量 ${raw.apiKeyEnv}`);
    } else {
      warnings.push('尚未设置 API 密钥，执行「设置 API 密钥」后再试');
    }
  }

  const format = raw.commit.format as CommitFormat;
  const allowedFormats: CommitFormat[] = ['conventional', 'angular', 'gitmoji', 'plain', 'custom'];
  if (!allowedFormats.includes(format)) {
    errors.push(`未知的提交信息格式 "${raw.commit.format}"`);
  }

  const minSeverity = raw.review.minSeverity as Severity;
  if (!['high', 'medium', 'low'].includes(minSeverity)) {
    errors.push(`review.minSeverity 必须是 high / medium / low`);
  }

  if (errors.length > 0 || !isProviderId(provider)) {
    return { errors, warnings, modelDefaulted };
  }

  const language = resolveLanguage(raw.commit.language, vscodeLanguage);

  return {
    errors,
    warnings,
    modelDefaulted,
    config: {
      provider,
      baseUrl,
      model,
      autoFetchModels: raw.autoFetchModels ?? true,
      availableModels: raw.availableModels ?? [],
      apiKey,
      temperature,
      maxTokens: raw.maxTokens,
      requestTimeoutMs: raw.requestTimeoutMs,
      maxRetries: raw.maxRetries ?? 1,
      apiKeyEnv: raw.apiKeyEnv ?? '',
      language,
      commit: {
        format,
        language,
        templateId: raw.commit.templateId,
        maxSubjectLength: raw.commit.maxSubjectLength ?? 72,
        includeBody: raw.commit.includeBody ?? true,
        recentCommitCount: raw.commit.recentCommitCount ?? 5,
        confirmBeforeInsert: raw.commit.confirmBeforeInsert ?? false,
      },
      diff: {
        maxTotalChars: raw.diff.maxTotalChars ?? 48000,
        maxFileChars: raw.diff.maxFileChars ?? 20000,
        excludeGlobs: raw.diff.excludeGlobs ?? [],
        redactSecrets: raw.diff.redactSecrets ?? true,
      },
      review: {
        templateId: raw.review.templateId,
        minSeverity,
        maxIssues: raw.review.maxIssues ?? 30,
        showDiagnostics: raw.review.showDiagnostics ?? true,
      },
      customTemplates: raw.customTemplates ?? [],
    },
  };
}
