import * as vscode from 'vscode';
import { PromptTemplate } from '../../domain/prompt/renderTemplate';
import { RawConfig, validateConfig, ValidationResult, ResolvedConfig } from './configTypes';

export const CONFIG_SECTION = 'commitCraft';

export function readRawConfig(scope?: vscode.Uri): RawConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, scope ?? null);
  return {
    provider: cfg.get<string>('provider', 'openai-compatible'),
    baseUrl: cfg.get<string>('baseUrl', 'https://api.openai.com/v1'),
    model: cfg.get<string>('model', 'gpt-4o-mini'),
    autoFetchModels: cfg.get<boolean>('autoFetchModels', true),
    availableModels: cfg.get<string[]>('availableModels', []),
    temperature: cfg.get<number>('temperature', 0.2),
    maxTokens: cfg.get<number>('maxTokens', 1024),
    requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 60000),
    maxRetries: cfg.get<number>('maxRetries', 1),
    apiKeyEnv: cfg.get<string>('apiKeyEnv', ''),
    commit: {
      format: cfg.get<string>('commit.format', 'conventional'),
      language: cfg.get<string>('commit.language', 'auto'),
      templateId: cfg.get<string>('commit.templateId', 'builtin-conventional-zh'),
      maxSubjectLength: cfg.get<number>('commit.maxSubjectLength', 72),
      includeBody: cfg.get<boolean>('commit.includeBody', true),
      recentCommitCount: cfg.get<number>('commit.recentCommitCount', 5),
      confirmBeforeInsert: cfg.get<boolean>('commit.confirmBeforeInsert', false),
    },
    diff: {
      maxTotalChars: cfg.get<number>('diff.maxTotalChars', 48000),
      maxFileChars: cfg.get<number>('diff.maxFileChars', 20000),
      excludeGlobs: cfg.get<string[]>('diff.excludeGlobs', []),
      redactSecrets: cfg.get<boolean>('diff.redactSecrets', true),
    },
    review: {
      templateId: cfg.get<string>('review.templateId', 'builtin-review-standard'),
      minSeverity: cfg.get<string>('review.minSeverity', 'low'),
      maxIssues: cfg.get<number>('review.maxIssues', 30),
      showDiagnostics: cfg.get<boolean>('review.showDiagnostics', true),
    },
    customTemplates: (cfg.get<Partial<PromptTemplate>[]>('customTemplates', []) ?? []).filter(
      (t) => t && typeof t === 'object',
    ),
  };
}

/** 密钥存储：只走 SecretStorage / 环境变量，绝不落到 settings.json */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private keyOf(provider: string): string {
    return `${CONFIG_SECTION}.apiKey.${provider}`;
  }

  async get(provider: string): Promise<string | undefined> {
    const value = await this.secrets.get(this.keyOf(provider));
    return value && value.trim() ? value.trim() : undefined;
  }

  async set(provider: string, value: string): Promise<void> {
    await this.secrets.store(this.keyOf(provider), value.trim());
  }

  async clear(provider: string): Promise<void> {
    await this.secrets.delete(this.keyOf(provider));
  }

  async resolve(provider: string, envName: string): Promise<string | undefined> {
    const fromStore = await this.get(provider);
    if (fromStore) {
      return fromStore;
    }
    if (envName) {
      const fromEnv = process.env[envName];
      if (fromEnv && fromEnv.trim()) {
        return fromEnv.trim();
      }
    }
    return undefined;
  }
}

export interface LoadedConfig {
  config?: ResolvedConfig;
  validation: ValidationResult;
}

/** 读取 + 校验 + 解析密钥，一步到位 */
export async function loadConfig(secrets: SecretStore, scope?: vscode.Uri): Promise<LoadedConfig> {
  const raw = readRawConfig(scope);
  const apiKey = await secrets.resolve(raw.provider, raw.apiKeyEnv);
  const validation = validateConfig(raw, vscode.env.language, apiKey);
  return { config: validation.config, validation };
}
