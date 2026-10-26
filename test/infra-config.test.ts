import { describe, expect, it } from 'vitest';
import { RawConfig, resolveLanguage, validateConfig } from '../src/infra/config/configTypes';
import { AiError } from '../src/infra/ai/types';

function makeRaw(over: Partial<RawConfig> = {}): RawConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    autoFetchModels: true,
    availableModels: [],
    temperature: 0.2,
    maxTokens: 1024,
    requestTimeoutMs: 60000,
    maxRetries: 1,
    apiKeyEnv: '',
    commit: {
      format: 'conventional',
      language: 'auto',
      templateId: 'builtin-conventional-zh',
      maxSubjectLength: 72,
      includeBody: true,
      recentCommitCount: 5,
      confirmBeforeInsert: false,
    },
    diff: { maxTotalChars: 48000, maxFileChars: 20000, excludeGlobs: [], redactSecrets: true },
    review: { templateId: 'builtin-review-standard', minSeverity: 'low', maxIssues: 30, showDiagnostics: true },
    customTemplates: [],
    ...over,
  };
}

describe('validateConfig', () => {
  it('合法配置归一化成功', () => {
    const { config, errors } = validateConfig(makeRaw(), 'zh-cn', 'key');
    expect(errors).toEqual([]);
    expect(config?.provider).toBe('openai-compatible');
    expect(config?.language).toBe('zh-CN');
    expect(config?.apiKey).toBe('key');
  });

  it('非法 URL 报错', () => {
    const { errors } = validateConfig(makeRaw({ baseUrl: 'not a url' }), 'en', 'key');
    expect(errors.some((e) => e.includes('URL'))).toBe(true);
  });

  it('非 localhost 的明文 http 给出警告', () => {
    const { warnings, errors } = validateConfig(makeRaw({ baseUrl: 'http://api.example.com/v1' }), 'en', 'key');
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('明文'))).toBe(true);
  });

  it('本地 http 不警告', () => {
    const { warnings } = validateConfig(makeRaw({ baseUrl: 'http://localhost:11434', provider: 'ollama' }), 'en');
    expect(warnings).toEqual([]);
  });

  it('模型名称为空时回填推荐默认值并提示', () => {
    const { errors, warnings, config, modelDefaulted } = validateConfig(makeRaw({ model: '  ' }), 'en', 'key');
    expect(errors).toEqual([]);
    expect(modelDefaulted).toBe('gpt-4o-mini');
    expect(config?.model).toBe('gpt-4o-mini');
    expect(warnings.some((w) => w.includes('推荐默认模型'))).toBe(true);
  });

  it('留空时的默认模型跟着接口地址走，而不是只看服务商类型', () => {
    // DeepSeek 走的是 openai-compatible 协议，但兜底模型不该是 OpenAI 的 gpt-4o-mini
    const { config, modelDefaulted, warnings } = validateConfig(
      makeRaw({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: '' }),
      'en',
      'key',
    );
    expect(config?.model).toBe('deepseek-chat');
    expect(modelDefaulted).toBe('deepseek-chat');
    expect(warnings.some((w) => w.includes('DeepSeek') && w.includes('deepseek-chat'))).toBe(true);
  });

  it('Azure 没有默认模型，留空则报错并给出填法', () => {
    const { errors } = validateConfig(
      makeRaw({ provider: 'azure-openai', baseUrl: 'https://x.openai.azure.com/openai', model: '' }),
      'en',
      'key',
    );
    expect(errors.some((e) => e.includes('模型名称'))).toBe(true);
  });

  it('Ollama 配了远程地址给出不匹配提示', () => {
    const { warnings } = validateConfig(
      makeRaw({ provider: 'ollama', baseUrl: 'https://api.openai.com/v1' }),
      'en',
    );
    expect(warnings.some((w) => w.includes('Ollama'))).toBe(true);
  });

  it('Anthropic 地址配到 OpenAI 兼容类型时给出切换提示', () => {
    const { warnings } = validateConfig(
      makeRaw({ baseUrl: 'https://api.anthropic.com/v1' }),
      'en',
      'key',
    );
    expect(warnings.some((w) => w.includes('Anthropic'))).toBe(true);
  });

  it('未知服务商报错', () => {
    const { errors, config } = validateConfig(makeRaw({ provider: 'weird' }), 'en', 'key');
    expect(errors[0]).toContain('未知的服务商');
    expect(config).toBeUndefined();
  });

  it('温度越界报错', () => {
    expect(validateConfig(makeRaw({ temperature: 3 }), 'en', 'key').errors.length).toBeGreaterThan(0);
  });

  it('缺少密钥时只警告不报错', () => {
    const { errors, warnings } = validateConfig(makeRaw(), 'en', undefined);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('API 密钥'))).toBe(true);
  });

  it('ollama 无需密钥', () => {
    const { warnings } = validateConfig(makeRaw({ provider: 'ollama', baseUrl: 'http://localhost:11434' }), 'en');
    expect(warnings).toEqual([]);
  });

  it('未知提交格式报错', () => {
    const raw = makeRaw();
    raw.commit.format = 'weird';
    expect(validateConfig(raw, 'en', 'k').errors.length).toBeGreaterThan(0);
  });
});

describe('resolveLanguage', () => {
  it('auto 跟随编辑器语言', () => {
    expect(resolveLanguage('auto', 'zh-cn')).toBe('zh-CN');
    expect(resolveLanguage('auto', 'en-US')).toBe('en');
    expect(resolveLanguage('en', 'zh-cn')).toBe('en');
  });
});

describe('AiError', () => {
  it('按错误码判定是否可重试', () => {
    expect(new AiError('x', 'rate-limit').retryable).toBe(true);
    expect(new AiError('x', 'network').retryable).toBe(true);
    expect(new AiError('x', 'auth').retryable).toBe(false);
    expect(new AiError('x', 'bad-request').retryable).toBe(false);
  });

  it('输出面向用户的中文提示', () => {
    expect(new AiError('x', 'auth').toUserMessage()).toContain('API 密钥');
    expect(new AiError('x', 'timeout').toUserMessage()).toContain('超时');
  });
});
