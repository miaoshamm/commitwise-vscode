export type TemplateType = 'commit' | 'review';

export interface PromptTemplate {
  id: string;
  type: TemplateType;
  name: string;
  description?: string;
  systemPrompt?: string;
  userPrompt: string;
  builtin?: boolean;
}

/** 模板中可用的变量，及其说明（用于设置提示与校验） */
export const TEMPLATE_VARIABLES: Record<string, string> = {
  diff: '暂存区补丁文本（已过滤、截断、脱敏）',
  stagedFiles: '暂存文件清单，含增删行数与排除标记',
  fileStats: '文件数量与总增删行数',
  repoName: '仓库目录名',
  branch: '当前分支名',
  recentCommits: '最近若干条提交标题',
  language: '输出语言',
  format: '提交信息格式',
  maxSubjectLength: '首行最大长度',
  bodyInstruction: '关于是否输出正文的说明',
  truncated: '是否存在被截断或排除的文件',
};

const VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export interface RenderResult {
  text: string;
  /** 模板中引用但未提供取值的变量名 */
  missing: string[];
}

export function renderTemplate(template: string, vars: Record<string, string | number | boolean | undefined>): RenderResult {
  const missing: string[] = [];
  const text = template.replace(VAR_PATTERN, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) {
      missing.push(name);
      return '';
    }
    return String(value);
  });
  return { text, missing: [...new Set(missing)] };
}

export function usedVariables(template: string): string[] {
  const found: string[] = [];
  for (const m of template.matchAll(VAR_PATTERN)) {
    found.push(m[1]);
  }
  return [...new Set(found)];
}

export interface TemplateValidationError {
  field: 'id' | 'type' | 'name' | 'userPrompt' | 'systemPrompt';
  message: string;
}

/** 校验自定义模板，错误信息直接面向用户 */
export function validateTemplate(tpl: Partial<PromptTemplate>): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];
  if (!tpl.id || !/^[a-zA-Z0-9_-]{2,64}$/.test(tpl.id)) {
    errors.push({ field: 'id', message: 'id 必填，只能包含字母、数字、下划线或连字符（2–64 位）' });
  }
  if (tpl.type !== 'commit' && tpl.type !== 'review') {
    errors.push({ field: 'type', message: 'type 必须是 commit 或 review' });
  }
  if (!tpl.name || !tpl.name.trim()) {
    errors.push({ field: 'name', message: 'name 必填' });
  }
  if (!tpl.userPrompt || !tpl.userPrompt.trim()) {
    errors.push({ field: 'userPrompt', message: 'userPrompt 必填' });
  } else if (!/\{\{\s*diff\s*\}\}/.test(tpl.userPrompt)) {
    errors.push({ field: 'userPrompt', message: 'userPrompt 必须包含 {{diff}}，否则模型看不到代码变更' });
  }
  return errors;
}
