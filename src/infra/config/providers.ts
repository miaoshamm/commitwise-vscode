/**
 * 服务商标识的最小集合。
 *
 * 单独成文件是为了让 providerPresets 和 configTypes 都只依赖它，
 * 避免两者互相 import 形成环。
 */
export const PROVIDER_IDS = ['openai-compatible', 'anthropic', 'azure-openai', 'ollama'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'openai-compatible': 'OpenAI 兼容接口',
  anthropic: 'Anthropic Claude',
  'azure-openai': 'Azure OpenAI',
  ollama: 'Ollama（本地）',
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
