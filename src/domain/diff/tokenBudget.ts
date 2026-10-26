/**
 * 上下文预算估算。
 *
 * 不引入 tiktoken（原生依赖会影响跨平台打包与扩展体积），
 * 用 CTP 级启发式：中日韩字符 ≈ 1 token/字，其余 ≈ 1 token / 3.5 字符。
 * 对"是否超预算"的判断足够，且偏保守。
 */

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 3.5);
}

/** 在给定 token 预算下，大约能容纳多少字符（按 70% 英文代码 + 30% 中文注释估算） */
export function charBudgetFor(maxTokens: number): number {
  return Math.floor(maxTokens * 3.2);
}

export interface BudgetReport {
  estimatedTokens: number;
  maxTokens: number;
  fits: boolean;
  /** 超出预算时，建议把字符上限下调到多少 */
  suggestedMaxChars: number;
}

export function checkBudget(patch: string, maxTokens: number): BudgetReport {
  const estimatedTokens = estimateTokens(patch);
  return {
    estimatedTokens,
    maxTokens,
    fits: estimatedTokens <= maxTokens,
    suggestedMaxChars: estimatedTokens > maxTokens ? Math.floor((patch.length * maxTokens) / estimatedTokens) : patch.length,
  };
}
