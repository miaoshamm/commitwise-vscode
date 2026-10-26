export type Severity = 'high' | 'medium' | 'low';
export type Category = 'bug' | 'security' | 'performance' | 'style' | 'maintainability' | 'test' | 'compat';

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export interface ReviewIssue {
  id: string;
  file: string;
  /** 新增行行号；为 undefined 表示只能定位到文件级 */
  line?: number;
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  suggestion?: string;
  /** 定位精度：line = 精确到新增行，file = 仅文件级 */
  anchor: 'line' | 'file';
}

export interface ReviewResult {
  summary: string;
  issues: ReviewIssue[];
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  high: 'high',
  critical: 'high',
  blocker: 'high',
  error: 'high',
  major: 'high',
  medium: 'medium',
  moderate: 'medium',
  warning: 'medium',
  warn: 'medium',
  normal: 'medium',
  low: 'low',
  minor: 'low',
  info: 'low',
  suggestion: 'low',
  nit: 'low',
  trivial: 'low',
};

const CATEGORY_ALIASES: Record<string, Category> = {
  bug: 'bug',
  correctness: 'bug',
  logic: 'bug',
  error: 'bug',
  security: 'security',
  vuln: 'security',
  performance: 'performance',
  perf: 'performance',
  efficiency: 'performance',
  style: 'style',
  formatting: 'style',
  naming: 'style',
  maintainability: 'maintainability',
  design: 'maintainability',
  readability: 'maintainability',
  refactor: 'maintainability',
  test: 'test',
  testing: 'test',
  coverage: 'test',
  compat: 'compat',
  compatibility: 'compat',
  deprecation: 'compat',
};

export function normalizeSeverity(value: unknown): Severity {
  if (typeof value !== 'string') {
    return 'medium';
  }
  return SEVERITY_ALIASES[value.trim().toLowerCase()] ?? 'medium';
}

export function normalizeCategory(value: unknown): Category {
  if (typeof value !== 'string') {
    return 'maintainability';
  }
  return CATEGORY_ALIASES[value.trim().toLowerCase()] ?? 'maintainability';
}

function normalizeFilePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  let p = raw.trim().replace(/\\/g, '/');
  if (!p) {
    return undefined;
  }
  p = p.replace(/^"(.*)"$/, '$1');
  p = p.replace(/^[ab]\//, '');
  p = p.replace(/^\.\//, '');
  return p;
}

export function normalizeLine(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const m = /\d+/.exec(raw);
    if (m) {
      const n = Number(m[0]);
      if (n > 0) {
        return n;
      }
    }
  }
  return undefined;
}

export interface JsonExtraction {
  value?: unknown;
  error?: string;
  /** 是否做过额外修复（去围栏 / 截取 / 去尾逗号） */
  repaired: boolean;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 从模型输出中提取 JSON。容忍：代码块围栏、前后解释文字、尾随逗号、BOM。
 */
export function extractJson(raw: string): JsonExtraction {
  let repaired = false;
  let text = raw.replace(/^\uFEFF/, '').trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    text = fenced[1].trim();
    repaired = true;
  }

  let value = tryParse(text);
  if (value !== undefined) {
    return { value, repaired };
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
    repaired = true;
    value = tryParse(text);
    if (value !== undefined) {
      return { value, repaired };
    }
  }

  // 去掉对象/数组中的尾随逗号后重试
  const noTrailing = text.replace(/,\s*([}\]])/g, '$1');
  if (noTrailing !== text) {
    repaired = true;
    value = tryParse(noTrailing);
    if (value !== undefined) {
      return { value, repaired };
    }
  }

  return { error: '模型输出不是合法 JSON', repaired };
}

export interface ParseReviewOutcome {
  result?: ReviewResult;
  error?: string;
  repaired: boolean;
  /** 被丢弃的畸形条目数 */
  dropped: number;
}

/** 把模型返回的 JSON 规范化为 ReviewResult，逐条容错 */
export function parseReviewResponse(raw: string): ParseReviewOutcome {
  const extracted = extractJson(raw);
  if (extracted.value === undefined) {
    return { error: extracted.error, repaired: extracted.repaired, dropped: 0 };
  }

  let payload = extracted.value as Record<string, unknown> | unknown[];
  if (Array.isArray(payload)) {
    payload = { summary: '', issues: payload };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { error: '模型返回的 JSON 结构不符合预期', repaired: extracted.repaired, dropped: 0 };
  }

  const obj = payload as Record<string, unknown>;
  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: ReviewIssue[] = [];
  let dropped = 0;

  rawIssues.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      dropped++;
      return;
    }
    const it = item as Record<string, unknown>;
    const file = normalizeFilePath(it.file ?? it.path ?? it.filename);
    const title = typeof it.title === 'string' ? it.title.trim() : typeof it.message === 'string' ? it.message.trim() : '';
    if (!file || !title) {
      dropped++;
      return;
    }
    const line = normalizeLine(it.line ?? it.lineNumber ?? it.startLine);
    issues.push({
      id: `issue-${index}`,
      file,
      line,
      severity: normalizeSeverity(it.severity ?? it.level),
      category: normalizeCategory(it.category ?? it.type),
      title,
      detail: typeof it.detail === 'string' ? it.detail.trim() : typeof it.description === 'string' ? it.description.trim() : '',
      suggestion: typeof it.suggestion === 'string' ? it.suggestion.trim() : typeof it.fix === 'string' ? it.fix.trim() : undefined,
      anchor: line ? 'line' : 'file',
    });
  });

  return {
    result: {
      summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
      issues,
    },
    repaired: extracted.repaired,
    dropped,
  };
}
