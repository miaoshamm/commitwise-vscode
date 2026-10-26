/**
 * 脱敏：在把 diff 发出去之前，把疑似密钥替换为占位符。
 * 只做保守的正则匹配，宁可漏也不误伤业务代码（除最后的赋值式兜底）。
 */

interface Rule {
  name: string;
  re: RegExp;
  replace: string | ((sub: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  {
    name: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '***REDACTED PRIVATE KEY***',
  },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: '***REDACTED***' },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replace: '***REDACTED***' },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '***REDACTED***' },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: '***REDACTED***' },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: '***REDACTED***' },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: '***REDACTED***' },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: '***REDACTED JWT***',
  },
  {
    name: 'bearer',
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi,
    replace: (_m: string, scheme: string) => `${scheme} ***REDACTED***`,
  },
  {
    // 键名保留，值打码，便于模型理解"这里本来是密钥"
    name: 'assignment',
    re: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|private[_-]?key|client[_-]?secret)\b(\s*[:=]\s*)(['"`])([^'"`\r\n]{8,})\3/gi,
    replace: (_m: string, key: string, sep: string, quote: string) =>
      `${key}${sep}${quote}***REDACTED***${quote}`,
  },
];

export interface RedactResult {
  text: string;
  hits: number;
  rules: string[];
}

export function redactSecrets(text: string): RedactResult {
  let out = text;
  let hits = 0;
  const matched: string[] = [];

  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      hits++;
      if (!matched.includes(rule.name)) {
        matched.push(rule.name);
      }
      if (typeof rule.replace === 'function') {
        return (rule.replace as (...a: unknown[]) => string)(...args);
      }
      return rule.replace as string;
    });
  }

  return { text: out, hits, rules: matched };
}
