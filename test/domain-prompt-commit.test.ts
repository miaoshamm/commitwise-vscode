import { describe, expect, it } from 'vitest';
import { TemplateRegistry, BUILTIN_TEMPLATES } from '../src/domain/prompt/builtinTemplates';
import { renderTemplate, usedVariables, validateTemplate } from '../src/domain/prompt/renderTemplate';
import {
  buildCorrectionPrompt,
  cleanModelOutput,
  parseCommitMessage,
} from '../src/domain/commit/messageValidator';

describe('renderTemplate', () => {
  it('替换变量', () => {
    const r = renderTemplate('分支 {{branch}}，{{ count }} 个文件', { branch: 'main', count: 3 });
    expect(r.text).toBe('分支 main，3 个文件');
    expect(r.missing).toEqual([]);
  });

  it('缺失变量替换为空串并记录', () => {
    const r = renderTemplate('{{diff}}{{nope}}', { diff: 'ABC' });
    expect(r.text).toBe('ABC');
    expect(r.missing).toEqual(['nope']);
  });

  it('未转义的花括号不影响', () => {
    const r = renderTemplate('{ "a": 1 }', {});
    expect(r.text).toBe('{ "a": 1 }');
  });

  it('提取使用的变量', () => {
    expect(usedVariables('{{diff}} {{branch}} {{diff}}').sort()).toEqual(['branch', 'diff']);
  });
});

describe('validateTemplate', () => {
  it('缺少 {{diff}} 时报错', () => {
    const errors = validateTemplate({ id: 'x', type: 'commit', name: 'x', userPrompt: '请生成提交信息' });
    expect(errors.map((e) => e.field)).toContain('userPrompt');
  });

  it('合法模板无错误', () => {
    const errors = validateTemplate({
      id: 'team-a',
      type: 'commit',
      name: '团队模板',
      userPrompt: '{{diff}}',
    });
    expect(errors).toEqual([]);
  });

  it('非法 id 与类型被拒绝', () => {
    const errors = validateTemplate({ id: 'a b', type: 'other' as never, name: '', userPrompt: '{{diff}}' });
    expect(errors).toHaveLength(3);
  });
});

describe('TemplateRegistry', () => {
  it('内置模板齐全', () => {
    const registry = new TemplateRegistry();
    expect(registry.list('commit').length).toBeGreaterThanOrEqual(4);
    expect(registry.list('review').length).toBeGreaterThanOrEqual(2);
    expect(registry.get('builtin-conventional-zh')?.builtin).toBe(true);
  });

  it('自定义模板覆盖同 id 内置模板', () => {
    const registry = new TemplateRegistry({
      customTemplates: [{ id: 'builtin-plain', type: 'commit', name: '我的简洁模板', userPrompt: '{{diff}}' }],
    });
    expect(registry.get('builtin-plain')?.name).toBe('我的简洁模板');
    expect(registry.get('builtin-plain')?.builtin).toBe(false);
  });

  it('非法自定义模板被跳过并记录警告', () => {
    const registry = new TemplateRegistry({
      customTemplates: [{ id: 'bad', type: 'commit', name: '坏的', userPrompt: '没有 diff 变量' }],
    });
    expect(registry.get('bad')).toBeUndefined();
    expect(registry.warnings).toHaveLength(1);
  });

  it('id 不存在时回退到同类型内置模板', () => {
    const registry = new TemplateRegistry();
    const { template, fellBack } = registry.resolve('not-exist', 'review');
    expect(fellBack).toBe(true);
    expect(template.type).toBe('review');
  });

  it('类型不匹配也回退', () => {
    const registry = new TemplateRegistry();
    const { fellBack, template } = registry.resolve('builtin-review-standard', 'commit');
    expect(fellBack).toBe(true);
    expect(template.type).toBe('commit');
  });

  it('内置模板均包含 {{diff}}', () => {
    for (const tpl of BUILTIN_TEMPLATES) {
      expect(tpl.userPrompt).toContain('{{diff}}');
    }
  });
});

describe('cleanModelOutput', () => {
  it('去掉代码块围栏', () => {
    const r = cleanModelOutput('```\nfeat: 新增登录\n```');
    expect(r.message).toBe('feat: 新增登录');
    expect(r.hadFence).toBe(true);
  });

  it('去掉前置寒暄', () => {
    const r = cleanModelOutput('好的，以下是提交信息：\n\nfix: 修复空指针');
    expect(r.message).toBe('fix: 修复空指针');
    expect(r.hadPreamble).toBe(true);
  });

  it('去掉整体包裹的引号', () => {
    expect(cleanModelOutput('"feat: 新增导出"').message).toBe('feat: 新增导出');
  });

  it('保留正常多行内容', () => {
    const input = 'feat(api): 新增导出\n\n- 支持 CSV\n- 支持 XLSX';
    expect(cleanModelOutput(input).message).toBe(input);
  });
});

describe('parseCommitMessage', () => {
  const opts = { format: 'conventional' as const, maxSubjectLength: 72 };

  it('合法提交信息通过校验', () => {
    const r = parseCommitMessage('feat(auth): 新增短信登录', opts);
    expect(r.valid).toBe(true);
    expect(r.type).toBe('feat');
    expect(r.scope).toBe('auth');
    expect(r.description).toBe('新增短信登录');
    expect(r.issues).toEqual([]);
  });

  it('拆分正文', () => {
    const r = parseCommitMessage('fix: 修复超时\n\n- 调整重试次数\n- 补充日志', opts);
    expect(r.body).toContain('调整重试次数');
    expect(r.valid).toBe(true);
  });

  it('未知 type 判为不合法', () => {
    const r = parseCommitMessage('update: 改点东西', opts);
    expect(r.valid).toBe(false);
    expect(r.issues[0].code).toBe('unknown-type');
  });

  it('缺少 type 前缀判为不合法', () => {
    const r = parseCommitMessage('修复了一个 bug', opts);
    expect(r.valid).toBe(false);
    expect(r.issues[0].code).toBe('missing-type');
  });

  it('首行过长只告警不阻断', () => {
    const r = parseCommitMessage(`feat: ${'很长的描述'.repeat(20)}`, opts);
    expect(r.valid).toBe(true);
    expect(r.issues.some((i) => i.code === 'too-long')).toBe(true);
  });

  it('末尾句号告警', () => {
    const r = parseCommitMessage('feat: 新增导出。', opts);
    expect(r.issues.some((i) => i.code === 'trailing-period')).toBe(true);
  });

  it('识别 breaking change', () => {
    const r = parseCommitMessage('feat(api)!: 移除 v1 接口', opts);
    expect(r.breaking).toBe(true);
  });

  it('plain 格式不做 type 校验', () => {
    const r = parseCommitMessage('调整首页布局', { format: 'plain', maxSubjectLength: 72 });
    expect(r.valid).toBe(true);
  });

  it('空输出直接判为不合法', () => {
    expect(parseCommitMessage('   ', opts).valid).toBe(false);
  });
});

describe('buildCorrectionPrompt', () => {
  it('包含违规原因与原始输出', () => {
    const parsed = parseCommitMessage('update: 改点东西', { format: 'conventional', maxSubjectLength: 72 });
    const prompt = buildCorrectionPrompt(parsed, { format: 'conventional', maxSubjectLength: 72 });
    expect(prompt).toContain('不在规范集合内');
    expect(prompt).toContain('update: 改点东西');
    expect(prompt).toContain('feat');
  });
});
