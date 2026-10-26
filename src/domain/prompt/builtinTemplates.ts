import { PromptTemplate, TemplateType, validateTemplate } from './renderTemplate';

const DIFF_BLOCK = `变更文件：
{{stagedFiles}}

Diff：
{{diff}}`;

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: 'builtin-conventional-zh',
    type: 'commit',
    name: 'Conventional Commits（中文）',
    description: '默认模板。type(scope): subject + 中文正文',
    builtin: true,
    systemPrompt: '你是严格的提交信息撰写助手。只输出提交信息本身，不要输出解释、不要使用 Markdown 代码块、不要在前后加引号。',
    userPrompt: `请根据下面的暂存区变更，生成一条符合 Conventional Commits 规范的提交信息。

要求：
- 输出语言：{{language}}
- 首行格式：<type>(<scope>): <subject>
- type 只能取以下值之一：feat、fix、docs、style、refactor、perf、test、build、ci、chore、revert
- scope 用变更涉及的模块名，无法判断时省略括号
- subject 动词开头、具体描述"做了什么"，不超过 {{maxSubjectLength}} 个字符，末尾不加句号
- {{bodyInstruction}}
- 只输出提交信息本身，不要任何解释或代码块

仓库：{{repoName}}
分支：{{branch}}

最近提交（仅作风格参考，不要照抄）：
{{recentCommits}}

${DIFF_BLOCK}`,
  },
  {
    id: 'builtin-conventional-en',
    type: 'commit',
    name: 'Conventional Commits（English）',
    description: 'English output with imperative mood subject',
    builtin: true,
    systemPrompt:
      'You are a precise commit message writer. Output the commit message only — no explanations, no markdown fences, no surrounding quotes.',
    userPrompt: `Write a Conventional Commits message for the staged changes below.

Rules:
- Language: English
- First line: <type>(<scope>): <subject>
- type must be one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
- subject in imperative mood, at most {{maxSubjectLength}} characters, no trailing period
- {{bodyInstruction}}
- Output the commit message only

Repository: {{repoName}}
Branch: {{branch}}

Recent commits (style reference only):
{{recentCommits}}

${DIFF_BLOCK}`,
  },
  {
    id: 'builtin-gitmoji',
    type: 'commit',
    name: 'Gitmoji',
    description: '以 emoji 开头的轻量风格',
    builtin: true,
    systemPrompt: '你是提交信息助手。只输出提交信息本身。',
    userPrompt: `请根据暂存区变更生成一条 Gitmoji 风格的提交信息。

要求：
- 首行格式：<emoji> <type>(<scope>): <subject>，例如 "✨ feat(api): 新增批量导出接口"
- emoji 从常用集合中选择：✨ 新功能、🐛 修 bug、📝 文档、♻️ 重构、⚡️ 性能、✅ 测试、🔧 配置、🔒️ 安全、🚑️ 紧急修复
- subject 不超过 {{maxSubjectLength}} 个字符，语言 {{language}}
- {{bodyInstruction}}
- 只输出提交信息本身

仓库：{{repoName}}
分支：{{branch}}

${DIFF_BLOCK}`,
  },
  {
    id: 'builtin-plain',
    type: 'commit',
    name: '简洁单行（无格式约束）',
    description: '不强制 type，只要一句准确的描述',
    builtin: true,
    systemPrompt: '你是提交信息助手。只输出一句话，不要任何前缀、标点结尾或解释。',
    userPrompt: `用一句话准确概括下面这次变更做了什么。语言：{{language}}，不超过 {{maxSubjectLength}} 个字符。

仓库：{{repoName}}
分支：{{branch}}

${DIFF_BLOCK}`,
  },
  {
    id: 'builtin-review-standard',
    type: 'review',
    name: '标准代码审查',
    description: '正确性 / 安全 / 性能 / 可维护性 / 测试五个维度',
    builtin: true,
    systemPrompt:
      '你是严谨的资深代码审查者。你只报告能在 diff 中明确定位、且有实际影响的问题。你从不评论纯格式偏好，从不复述代码，从不臆造文件里不存在的内容。你的输出必须是可直接 JSON.parse 的单个 JSON 对象。',
    userPrompt: `审查下面这段即将提交的代码变更。

只报告你能在 diff 中明确指出位置的、有实际影响的问题。

检查重点：
1. 正确性：逻辑错误、边界条件、空值/未定义处理、异步与并发陷阱、资源未释放
2. 安全：注入、越权、密钥或敏感信息硬编码、不安全反序列化、路径穿越
3. 性能：重复计算、N+1、无界内存增长、不必要的同步阻塞
4. 可维护性：命名误导、职责混乱、被吞掉的错误、复制粘贴遗留
5. 测试：新增逻辑缺少对应测试

严重级别定义：
- high：会导致线上故障、数据错误或安全问题，必须修复
- medium：潜在缺陷或明显设计问题，建议本次修复
- low：可改进项，可选

只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。结构：
{
  "summary": "对本次变更的整体评价，2-3 句中文",
  "issues": [
    {
      "file": "相对仓库根目录的路径，必须与下方变更文件中的路径完全一致",
      "line": 新增行的行号（数字，必须落在 diff 中以 + 开头的行）,
      "severity": "high | medium | low",
      "category": "bug | security | performance | style | maintainability | test | compat",
      "title": "一句话说明问题",
      "detail": "为什么是问题，会造成什么后果",
      "suggestion": "具体的修改建议，可含少量代码"
    }
  ]
}

如果确实没有发现问题，输出 {"summary": "...", "issues": []}。

仓库：{{repoName}}
分支：{{branch}}

${DIFF_BLOCK}`,
  },
  {
    id: 'builtin-review-security',
    type: 'review',
    name: '安全专项审查',
    description: '只关注安全与数据泄露风险',
    builtin: true,
    systemPrompt:
      '你是应用安全审查专家。只报告安全问题。输出必须是可直接 JSON.parse 的单个 JSON 对象。',
    userPrompt: `对下面这段即将提交的代码做安全审查。

重点：
- 硬编码密钥、令牌、证书
- 用户输入是否经过校验与转义（SQL/命令/模板/路径）
- 鉴权与越权：是否校验了调用方身份与资源归属
- 敏感数据是否进入日志、错误信息、响应体
- 依赖引入是否带来已知风险面
- 反序列化、文件上传、重定向等危险操作

只输出一个 JSON 对象，不要代码块、不要解释文字：
{
  "summary": "整体安全评价，2-3 句中文",
  "issues": [
    {
      "file": "路径，必须与输入一致",
      "line": 新增行行号,
      "severity": "high | medium | low",
      "category": "security",
      "title": "问题标题",
      "detail": "攻击路径与后果",
      "suggestion": "修复方式"
    }
  ]
}

没有安全问题就返回 {"summary": "...", "issues": []}。

${DIFF_BLOCK}`,
  },
];

export interface TemplateRegistryOptions {
  customTemplates?: Partial<PromptTemplate>[];
}

/** 合并内置模板与用户自定义模板（同 id 时自定义覆盖内置） */
export class TemplateRegistry {
  private readonly templates = new Map<string, PromptTemplate>();
  readonly warnings: string[] = [];

  constructor(opts: TemplateRegistryOptions = {}) {
    for (const tpl of BUILTIN_TEMPLATES) {
      this.templates.set(tpl.id, tpl);
    }
    for (const raw of opts.customTemplates ?? []) {
      const errors = validateTemplate(raw);
      if (errors.length > 0) {
        this.warnings.push(`自定义模板「${raw.id ?? raw.name ?? '未命名'}」已跳过：${errors.map((e) => e.message).join('；')}`);
        continue;
      }
      this.templates.set(raw.id!, {
        id: raw.id!,
        type: raw.type as TemplateType,
        name: raw.name!,
        description: raw.description,
        systemPrompt: raw.systemPrompt,
        userPrompt: raw.userPrompt!,
        builtin: false,
      });
    }
  }

  list(type?: TemplateType): PromptTemplate[] {
    const all = [...this.templates.values()];
    return type ? all.filter((t) => t.type === type) : all;
  }

  get(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  /** 取指定 id，不存在则回落到该类型的第一个内置模板 */
  resolve(id: string, type: TemplateType): { template: PromptTemplate; fellBack: boolean } {
    const found = this.templates.get(id);
    if (found && found.type === type) {
      return { template: found, fellBack: false };
    }
    const fallback = this.list(type).find((t) => t.builtin) ?? this.list(type)[0];
    return { template: fallback, fellBack: true };
  }
}
