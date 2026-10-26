import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RawConfig } from '../src/infra/config/configTypes';
import {
  applyValues,
  changedKeys,
  coerceLike,
  describeHealth,
  flattenRaw,
  maskSecret,
  SECTION,
  SETTINGS_SECTIONS,
} from '../src/infra/config/settingsSchema';

function makeRaw(patch: Partial<RawConfig> = {}): RawConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    autoFetchModels: true,
    availableModels: [],
    temperature: 0.2,
    maxTokens: 1024,
    requestTimeoutMs: 60000,
    maxRetries: 1,
    apiKeyEnv: '',
    commit: {
      format: 'conventional',
      language: 'auto',
      templateId: 'builtin-conventional-zh',
      maxSubjectLength: 72,
      includeBody: true,
      recentCommitCount: 5,
      confirmBeforeInsert: false,
    },
    diff: {
      maxTotalChars: 48000,
      maxFileChars: 20000,
      excludeGlobs: ['**/package-lock.json'],
      redactSecrets: true,
    },
    review: {
      templateId: 'builtin-review-standard',
      minSeverity: 'low',
      maxIssues: 30,
      showDiagnostics: true,
    },
    customTemplates: [],
    ...patch,
  };
}

describe('flattenRaw', () => {
  it('把嵌套配置摊平成完整键名', () => {
    const flat = flattenRaw(makeRaw());
    expect(flat['commitCraft.provider']).toBe('openai-compatible');
    expect(flat['commitCraft.commit.format']).toBe('conventional');
    expect(flat['commitCraft.diff.maxTotalChars']).toBe(48000);
    expect(flat['commitCraft.review.minSeverity']).toBe('low');
  });

  it('不把结构化对象 customTemplates 交给设置页编辑', () => {
    const flat = flattenRaw(makeRaw({ customTemplates: [{ id: 'mine' } as never] }));
    expect(flat['commitCraft.customTemplates']).toBeUndefined();
  });

  it('数组保持原样，不被展开成 a.0 / a.1', () => {
    const flat = flattenRaw(makeRaw());
    expect(flat['commitCraft.commit.recentCommitCount']).toBe(5);
    expect(flat['commitCraft.temperature']).toBe(0.2);
    expect(Array.isArray(flat['commitCraft.diff.excludeGlobs'])).toBe(true);
    expect(Object.keys(flat).some((k) => /\.\d+$/.test(k))).toBe(false);
  });
});

describe('applyValues', () => {
  it('写入嵌套键，其余保持不变', () => {
    const base = makeRaw();
    const next = applyValues(base, {
      'commitCraft.commit.format': 'gitmoji',
      'commitCraft.review.maxIssues': 50,
    });
    expect(next.commit.format).toBe('gitmoji');
    expect(next.review.maxIssues).toBe(50);
    expect(next.model).toBe('deepseek-chat');
  });

  it('不修改传入的基准对象', () => {
    const base = makeRaw();
    applyValues(base, { 'commitCraft.model': 'gpt-4o' });
    expect(base.model).toBe('deepseek-chat');
  });

  it('忽略未知键，设置页不能凭空造配置', () => {
    const next = applyValues(makeRaw(), {
      'commitCraft.notARealKey': 1,
      'commitCraft.commit.nope': 2,
      'someOtherExt.key': 3,
    });
    const loose = next as unknown as Record<string, unknown>;
    expect(loose.notARealKey).toBeUndefined();
    expect((next.commit as unknown as Record<string, unknown>).nope).toBeUndefined();
  });

  it('字符串数字转成 number（webview 传回来的值可能带类型漂移）', () => {
    const next = applyValues(makeRaw(), { 'commitCraft.temperature': '0.7' });
    expect(next.temperature).toBe(0.7);
    expect(typeof next.temperature).toBe('number');
  });

  it('非法数字回退为原值而不是 NaN', () => {
    const next = applyValues(makeRaw(), { 'commitCraft.temperature': 'abc' });
    expect(next.temperature).toBe(0.2);
  });

  it('布尔值从字符串识别', () => {
    const next = applyValues(makeRaw(), {
      'commitCraft.review.showDiagnostics': 'false',
      'commitCraft.commit.includeBody': false,
    });
    expect(next.review.showDiagnostics).toBe(false);
    expect(next.commit.includeBody).toBe(false);
  });

  it('多行文本转成数组，且过滤空行', () => {
    const next = applyValues(makeRaw(), {
      'commitCraft.diff.excludeGlobs': '**/dist/**\n\n  **/*.map  \n',
    });
    expect(next.diff.excludeGlobs).toEqual(['**/dist/**', '**/*.map']);
  });

  it('customTemplates 不会被设置页覆盖', () => {
    const base = makeRaw({ customTemplates: [{ id: 'mine', name: 'M' } as never] });
    const next = applyValues(base, { 'commitCraft.customTemplates': [] });
    expect(next.customTemplates).toHaveLength(1);
  });
});

describe('changedKeys', () => {
  it('只返回真正变化的键', () => {
    const before = flattenRaw(makeRaw());
    const after = flattenRaw(applyValues(makeRaw(), { 'commitCraft.model': 'gpt-4o' }));
    expect(changedKeys(before, after)).toEqual(['commitCraft.model']);
  });

  it('内容相同的数组不算变化', () => {
    const before = flattenRaw(makeRaw());
    const after = flattenRaw(makeRaw({ diff: { ...makeRaw().diff, excludeGlobs: ['**/package-lock.json'] } }));
    expect(changedKeys(before, after)).toEqual([]);
  });

  it('改动多个键时全部列出', () => {
    const before = flattenRaw(makeRaw());
    const after = flattenRaw(
      applyValues(makeRaw(), { 'commitCraft.model': 'gpt-4o', 'commitCraft.commit.format': 'plain' }),
    );
    expect(changedKeys(before, after).sort()).toEqual(['commitCraft.commit.format', 'commitCraft.model']);
  });
});

describe('coerceLike', () => {
  it('按样本类型收敛', () => {
    expect(coerceLike('12', 1)).toBe(12);
    expect(coerceLike('true', false)).toBe(true);
    expect(coerceLike('x', 'y')).toBe('x');
    expect(coerceLike(null, 'keep')).toBe('keep');
  });

  it('数组里的对象成员原样保留', () => {
    const sample = [{ id: 'a' }];
    const value = [{ id: 'b' }];
    expect(coerceLike(value, sample)).toEqual([{ id: 'b' }]);
  });
});

describe('maskSecret', () => {
  it('空值不显示掩码', () => {
    expect(maskSecret('')).toBeUndefined();
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it('短密钥全部打点，不泄露任何字符', () => {
    expect(maskSecret('abc123')).toBe('••••••');
  });

  it('长密钥只保留首三尾四', () => {
    const masked = maskSecret('sk-abcdefghijklmnop1234');
    expect(masked?.startsWith('sk-')).toBe(true);
    expect(masked?.endsWith('1234')).toBe(true);
    expect(masked).not.toContain('abcdefgh');
  });
});

describe('describeHealth', () => {
  const base = {
    errors: [] as string[],
    warnings: [] as string[],
    provider: 'openai-compatible',
    model: 'deepseek-chat',
    hasKey: true,
    requiresKey: true,
    envName: '',
    envPresent: false,
  };

  it('有错误时优先级最高', () => {
    const h = describeHealth({ ...base, errors: ['接口地址不是合法的 URL'] });
    expect(h.level).toBe('error');
    expect(h.detail).toContain('URL');
  });

  it('缺密钥时提示填写', () => {
    const h = describeHealth({ ...base, hasKey: false });
    expect(h.level).toBe('warn');
    expect(h.title).toContain('密钥');
  });

  it('Ollama 不需要密钥', () => {
    const h = describeHealth({ ...base, requiresKey: false, hasKey: false });
    expect(h.level).toBe('ok');
  });

  it('环境变量里有值时不算缺密钥', () => {
    const h = describeHealth({ ...base, hasKey: false, envName: 'DS_KEY', envPresent: true });
    expect(h.level).not.toBe('warn');
  });

  it('推荐默认模型时说明可用但未固定', () => {
    const h = describeHealth({
      ...base,
      warnings: ['未设置模型（commitCraft.model），已使用 OpenAI 兼容接口 的推荐默认模型 gpt-4o-mini'],
    });
    expect(h.level).toBe('ok');
    expect(h.detail).toContain('推荐');
  });

  it('普通警告排在默认模型说明之前', () => {
    const h = describeHealth({
      ...base,
      warnings: [
        '未设置模型（commitCraft.model），已使用 推荐默认模型 gpt-4o-mini',
        '接口地址使用明文 http，发送的代码内容可被中间人读取：http://x',
      ],
    });
    expect(h.level).toBe('warn');
    expect(h.detail).toContain('明文');
  });
});

describe('设置页 schema 与 package.json 的一致性', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const props: Record<string, unknown> = pkg.contributes.configuration.properties;

  it('每个分区都至少有一个字段', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.fields.length).toBeGreaterThan(0);
    }
  });

  it('schema 里的键都真实存在于 package.json 的配置声明中', () => {
    const missing: string[] = [];
    for (const section of SETTINGS_SECTIONS) {
      for (const field of section.fields) {
        if (!(field.key in props)) {
          missing.push(field.key);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('package.json 里用户需要手改的配置项都在设置页有入口', () => {
    // customTemplates 是结构化对象，刻意不在页面里编辑
    const exempt = new Set([`${SECTION}.customTemplates`, `${SECTION}.telemetry.enabled`]);
    const shown = new Set(SETTINGS_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)));
    const unexposed = Object.keys(props).filter((key) => !shown.has(key) && !exempt.has(key));
    expect(unexposed).toEqual([]);
  });

  it('数字字段都声明了范围，避免用户填出跑不起来的配置', () => {
    for (const section of SETTINGS_SECTIONS) {
      for (const field of section.fields) {
        if (field.type === 'number') {
          expect(typeof field.min, `${field.key} 缺 min`).toBe('number');
          expect(typeof field.max, `${field.key} 缺 max`).toBe('number');
          expect(field.min!).toBeLessThan(field.max!);
        }
      }
    }
  });

  it('select 字段要么给静态选项，要么声明动态来源', () => {
    for (const section of SETTINGS_SECTIONS) {
      for (const field of section.fields) {
        if (field.type === 'select') {
          const hasStatic = Array.isArray(field.options) && field.options.length > 0;
          expect(hasStatic || Boolean(field.optionsFrom), `${field.key} 没有可选项`).toBe(true);
        }
      }
    }
  });

  it('列表型字段的默认值确实是数组', () => {
    const raw = makeRaw();
    const flat = flattenRaw(raw);
    for (const section of SETTINGS_SECTIONS) {
      for (const field of section.fields) {
        if (field.type === 'list') {
          expect(Array.isArray(flat[field.key]), `${field.key} 默认值不是数组`).toBe(true);
        }
      }
    }
  });
});
