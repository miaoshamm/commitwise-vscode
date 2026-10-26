import { PreparedDiff } from '../domain/diff/prepareDiff';
import { PromptTemplate, renderTemplate } from '../domain/prompt/renderTemplate';
import { ChatMessage } from '../infra/ai/types';
import { languageName, ResolvedConfig } from '../infra/config/configTypes';
import { StagedSnapshot } from '../infra/git/diffCollector';

export function repoNameOf(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

export function buildVariables(
  snapshot: StagedSnapshot,
  prepared: PreparedDiff,
  config: ResolvedConfig,
): Record<string, string> {
  const additions = snapshot.files.reduce((s, f) => s + f.additions, 0);
  const deletions = snapshot.files.reduce((s, f) => s + f.deletions, 0);

  const truncatedParts: string[] = [];
  if (prepared.truncated.length > 0) {
    truncatedParts.push(`以下文件内容过长已截断：${prepared.truncated.join('、')}`);
  }
  const excluded = prepared.skipped.filter((s) => s.reason === 'excluded' && s.detail !== 'no hunk');
  if (excluded.length > 0) {
    truncatedParts.push(`以下文件按排除规则未提供内容：${excluded.map((s) => s.path).join('、')}`);
  }

  return {
    diff: prepared.patch,
    stagedFiles: prepared.fileList || '（空）',
    fileStats: `${snapshot.files.length} 个文件，+${additions} / -${deletions} 行`,
    repoName: repoNameOf(snapshot.root),
    branch: snapshot.branch,
    recentCommits: snapshot.recentCommits.length > 0 ? snapshot.recentCommits.map((s) => `- ${s}`).join('\n') : '（暂无历史提交）',
    language: languageName(config.commit.language),
    format: config.commit.format,
    maxSubjectLength: String(config.commit.maxSubjectLength),
    bodyInstruction: config.commit.includeBody
      ? '第二行留空，之后用列表补充「为什么这样改」，每条一行，不超过 5 条'
      : '只输出单行，不要正文',
    truncated: truncatedParts.length > 0 ? truncatedParts.join('；') : '无',
  };
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  missingVariables: string[];
}

export function buildMessages(
  template: PromptTemplate,
  snapshot: StagedSnapshot,
  prepared: PreparedDiff,
  config: ResolvedConfig,
): BuiltPrompt {
  const vars = buildVariables(snapshot, prepared, config);
  const rendered = renderTemplate(template.userPrompt, vars);
  const messages: ChatMessage[] = [];

  if (template.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: template.systemPrompt.trim() });
  }
  messages.push({ role: 'user', content: rendered.text });

  return { messages, missingVariables: rendered.missing };
}

/** 审查场景：把模型输出打回要求"只输出 JSON" */
export function buildReviewRepairMessage(rawOutput: string): string {
  return `你上一次的输出不是合法 JSON，无法解析。请只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。

上一次的输出开头是：
"""
${rawOutput.slice(0, 400)}
"""

请重新输出完整的 JSON 对象，结构为：
{"summary": "整体评价", "issues": [{"file": "路径", "line": 行号, "severity": "high|medium|low", "category": "bug|security|performance|style|maintainability|test|compat", "title": "标题", "detail": "说明", "suggestion": "建议"}]}`;
}
