export const CONVENTIONAL_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

export type CommitFormat = 'conventional' | 'angular' | 'gitmoji' | 'plain' | 'custom';

export interface CommitIssue {
  code:
    | 'missing-type'
    | 'unknown-type'
    | 'too-long'
    | 'trailing-period'
    | 'empty'
    | 'preamble'
    | 'lowercase-type';
  severity: 'error' | 'warn';
  message: string;
}

export interface ParsedCommit {
  /** 清理后的完整提交信息 */
  message: string;
  /** 首行 */
  header: string;
  /** 首行中 `:` 之后的部分 */
  description: string;
  type?: string;
  scope?: string;
  breaking: boolean;
  body?: string;
  issues: CommitIssue[];
  valid: boolean;
}

const PREAMBLE = /^(好(的)?[，,。]?|以下(是|为)|这是|根据(您|你)?的?|提交信息(如下)?|here('s| is)|sure|certainly|commit message)/i;

/**
 * 清洗模型输出：去掉代码块围栏、前置寒暄、包裹引号、多余空行。
 * 模型即使被要求"只输出结果"，也经常加这些壳。
 */
export function cleanModelOutput(raw: string): { message: string; hadPreamble: boolean; hadFence: boolean } {
  let text = raw.replace(/\r\n/g, '\n').trim();
  let hadFence = false;
  let hadPreamble = false;

  // 整体被 ``` 包裹（可能带语言标记）
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) {
    text = fenced[1].trim();
    hadFence = true;
  } else {
    // 内部还有围栏时，取第一个围栏块
    const inner = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/.exec(text);
    if (inner && text.indexOf('```') < 40) {
      text = inner[1].trim();
      hadFence = true;
    }
  }

  const lines = text.split('\n');
  // 去掉前置寒暄行（以冒号结尾且明显是引导语）
  while (lines.length > 1) {
    const first = lines[0].trim();
    if (!first) {
      lines.shift();
      continue;
    }
    const looksLikeLeadIn = /[:：]$/.test(first) && (PREAMBLE.test(first) || first.length < 40);
    if (looksLikeLeadIn) {
      lines.shift();
      hadPreamble = true;
      continue;
    }
    break;
  }

  text = lines.join('\n').trim();

  // 整体被引号包裹
  if (text.length > 2) {
    const pairs: Array<[string, string]> = [
      ['"', '"'],
      ["'", "'"],
      ['“', '”'],
    ];
    for (const [open, close] of pairs) {
      if (text.startsWith(open) && text.endsWith(close) && !text.slice(1, -1).includes(close)) {
        text = text.slice(1, -1).trim();
        break;
      }
    }
  }

  return { message: text.replace(/\n{3,}/g, '\n\n'), hadPreamble, hadFence };
}

const HEADER_RE = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?\s*[:：]\s*(.+)$/;
const GITMOJI_RE = /^([\p{Extended_Pictographic}\uFE0F\u200D]+)\s*(.+)$/u;

export interface ParseOptions {
  format: CommitFormat;
  maxSubjectLength: number;
}

export function parseCommitMessage(raw: string, opts: ParseOptions): ParsedCommit {
  const { format, maxSubjectLength } = opts;
  const issues: CommitIssue[] = [];
  const cleaned = cleanModelOutput(raw);
  const message = cleaned.message;

  if (!message) {
    return {
      message: '',
      header: '',
      description: '',
      breaking: false,
      issues: [{ code: 'empty', severity: 'error', message: '模型返回为空' }],
      valid: false,
    };
  }

  const lines = message.split('\n');
  const header = lines[0].trim();
  const body = lines.slice(1).join('\n').trim();
  let description = header;
  let type: string | undefined;
  let scope: string | undefined;
  let breaking = false;

  const strictFormat = format === 'conventional' || format === 'angular' || format === 'custom';

  if (format === 'gitmoji') {
    const m = GITMOJI_RE.exec(header);
    if (!m) {
      issues.push({ code: 'missing-type', severity: 'warn', message: '首行缺少 emoji 前缀' });
    }
    const afterEmoji = m ? m[2] : header;
    const hm = HEADER_RE.exec(afterEmoji);
    if (hm) {
      type = hm[1].toLowerCase();
      scope = hm[2];
      breaking = Boolean(hm[3]);
      description = hm[4].trim();
    }
    description = afterEmoji.trim();
  } else if (strictFormat) {
    const m = HEADER_RE.exec(header);
    if (!m) {
      issues.push({
        code: 'missing-type',
        severity: 'error',
        message: `首行不符合 "<type>(<scope>): <subject>" 格式：${header.slice(0, 40)}`,
      });
    } else {
      type = m[1];
      scope = m[2] || undefined;
      breaking = Boolean(m[3]);
      description = m[4].trim();
      if (type !== type.toLowerCase()) {
        issues.push({ code: 'lowercase-type', severity: 'warn', message: `type 建议小写：${type}` });
        type = type.toLowerCase();
      }
      if (!(CONVENTIONAL_TYPES as readonly string[]).includes(type)) {
        issues.push({
          code: 'unknown-type',
          severity: 'error',
          message: `type "${type}" 不在规范集合内（${CONVENTIONAL_TYPES.join('/')}）`,
        });
      }
    }
  } else {
    description = header;
  }

  if (header.length > maxSubjectLength) {
    issues.push({
      code: 'too-long',
      severity: 'warn',
      message: `首行 ${header.length} 字符，超过上限 ${maxSubjectLength}`,
    });
  }

  if (/[。.]$/.test(description) && description.length > 1) {
    issues.push({ code: 'trailing-period', severity: 'warn', message: '首行末尾不应有句号' });
  }

  const valid = !issues.some((i) => i.severity === 'error');

  return {
    message,
    header,
    description,
    type,
    scope,
    breaking,
    body: body || undefined,
    issues,
    valid,
  };
}

/** 把校验失败原因转成给模型的纠错指令，用于一次带反馈重试 */
export function buildCorrectionPrompt(parsed: ParsedCommit, opts: ParseOptions): string {
  const problems = parsed.issues.map((i) => `- ${i.message}`).join('\n');
  return `你上一次的输出不符合要求：
${problems}

上一次的输出是：
"""
${parsed.message}
"""

请修正上述问题，重新输出一条提交信息。仍然只输出提交信息本身，不要任何解释、不要代码块围栏。${
    opts.format === 'conventional' || opts.format === 'angular' || opts.format === 'custom'
      ? `\n首行必须是 <type>(<scope>): <subject>，type 只能取 ${CONVENTIONAL_TYPES.join('、')}，首行不超过 ${opts.maxSubjectLength} 个字符。`
      : ''
  }`;
}
