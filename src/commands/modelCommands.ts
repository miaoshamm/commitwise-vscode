import * as vscode from 'vscode';
import { AppDeps } from '../app/context';
import { ModelInfo, pickDefaultModel, sortModels, supportsModelList } from '../infra/ai/modelCatalog';
import { AiError } from '../infra/ai/types';
import { readRawConfig } from '../infra/config/configService';
import { PROVIDER_LABELS, ProviderId } from '../infra/config/providers';
import { ENDPOINT_PRESETS, EndpointPreset, matchEndpointPreset, presetOf } from '../infra/config/providerPresets';

const TARGET = vscode.ConfigurationTarget.Global;

async function writeConfig(updates: Record<string, unknown>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('commitCraft');
  for (const [key, value] of Object.entries(updates)) {
    await cfg.update(key, value, TARGET);
  }
}

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id as ProviderId] ?? id;
}

/** 拉取模型列表（带进度条），失败时返回 undefined 并把原因交给调用方决定是否提示 */
export async function fetchModelList(
  deps: AppDeps,
  opts: { provider: string; baseUrl: string; apiKey?: string; reason: string },
): Promise<{ models?: ModelInfo[]; error?: string }> {
  if (!supportsModelList(opts.provider)) {
    return { error: `${providerLabel(opts.provider)} 不支持自动获取模型列表，请手动填写模型名称` };
  }
  try {
    const models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `CommitCraft · 获取模型列表（${opts.reason}）`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          return await deps.models.fetch({
            provider: opts.provider,
            baseUrl: opts.baseUrl,
            apiKey: opts.apiKey,
            timeoutMs: 15000,
            signal: controller.signal,
          });
        } finally {
          sub.dispose();
        }
      },
    );
    deps.logger.info(`获取模型列表成功：${models.length} 个（${opts.provider} / ${opts.baseUrl}）`);
    return { models };
  } catch (err) {
    const message = err instanceof AiError ? err.toUserMessage() : (err as Error).message;
    deps.logger.warn(`获取模型列表失败：${message}`);
    return { error: message };
  }
}

/** 手动填写模型名，带该服务商的提示与推荐值 */
async function promptModelName(provider: string, current: string): Promise<string | undefined> {
  const preset = presetOf(provider);
  const value = await vscode.window.showInputBox({
    title: `${preset.label} · 模型名称`,
    prompt: preset.modelHint,
    value: current || preset.defaultModel,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : '模型名称不能为空'),
  });
  return value?.trim() || undefined;
}

export interface ModelPickItem extends vscode.QuickPickItem {
  model?: string;
  action?: 'input' | 'refresh' | 'settings' | 'fetch';
}

/**
 * 统一的「选模型」交互。
 *
 * 优先级：本地缓存 → 自动拉取 → 手动输入。
 * 用户不需要先去设置里填 availableModels 才能看到候选。
 */
export async function pickModel(deps: AppDeps, raw = readRawConfig()): Promise<string | undefined> {
  const preset = presetOf(raw.provider);
  const current = (raw.model ?? '').trim();
  const apiKey = await deps.secrets.resolve(raw.provider, raw.apiKeyEnv);

  let models: ModelInfo[] = deps.models.get(raw.provider, raw.baseUrl) ?? [];
  let fetchError: string | undefined;

  // 没有任何缓存且该服务商支持列举：自动拉一次
  if (models.length === 0 && supportsModelList(raw.provider) && apiKey?.trim() && raw.autoFetchModels) {
    const result = await fetchModelList(deps, {
      provider: raw.provider,
      baseUrl: raw.baseUrl,
      apiKey,
      reason: '首次使用，自动获取',
    });
    models = result.models ?? [];
    fetchError = result.error;
  } else if (models.length === 0 && supportsModelList(raw.provider) && !raw.autoFetchModels) {
    fetchError = '已关闭自动获取（commitCraft.autoFetchModels），可点下方按钮手动获取';
  } else if (models.length === 0 && supportsModelList(raw.provider) && !apiKey) {
    fetchError = `尚未保存 ${preset.label} 的密钥，无法自动获取模型列表`;
  } else if (models.length === 0 && !supportsModelList(raw.provider)) {
    fetchError = `${preset.label} 不支持自动获取，请手动填写`;
  }

  const manual = raw.availableModels ?? [];
  const merged = sortModels([...models, ...manual.map((id) => ({ id }))], raw.provider);
  const recommended = preset.suggestions.map((s) => s.id);

  const items: ModelPickItem[] = merged.map((m) => {
    const isCurrent = m.id === current;
    const star = recommended.includes(m.id) ? '$(star) ' : '';
    return {
      label: `${isCurrent ? '$(check) ' : star}${m.id}`,
      description: isCurrent ? '当前使用' : m.note,
      model: m.id,
    };
  });

  // 当前模型不在列表里时补一条，避免用户以为没生效
  if (current && !merged.some((m) => m.id === current)) {
    items.unshift({ label: `$(check) ${current}`, description: '当前使用（不在列表中）', model: current });
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  if (supportsModelList(raw.provider)) {
    items.push({
      label: `$(refresh) ${models.length > 0 ? '重新获取模型列表' : '从接口获取模型列表'}`,
      description: fetchError ? `上次失败：${fetchError}` : undefined,
      action: 'fetch',
    });
  }
  items.push({ label: '$(edit) 手动输入模型名称…', action: 'input' });
  items.push({ label: '$(gear) 打开设置…', action: 'settings' });

  const picked = await vscode.window.showQuickPick<ModelPickItem>(items, {
    title: '选择模型',
    placeHolder: `当前：${preset.label} / ${current || preset.defaultModel || '(未设置)'}`,
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }

  if (picked.action === 'settings') {
    await vscode.commands.executeCommand('commitCraft.openSettings', 'model');
    return undefined;
  }
  if (picked.action === 'fetch') {
    const result = await fetchModelList(deps, {
      provider: raw.provider,
      baseUrl: raw.baseUrl,
      apiKey,
      reason: '手动刷新',
    });
    if (!result.models) {
      void vscode.window.showWarningMessage(`获取模型列表失败：${result.error ?? '未知原因'}`, '手动输入').then((a) => {
        if (a === '手动输入') {
          void vscode.commands.executeCommand('commitCraft.selectModel');
        }
      });
      return undefined;
    }
    // 拉完直接回到选择列表，少一次点击
    return pickModel(deps, readRawConfig());
  }
  if (picked.action === 'input' || !picked.model) {
    return promptModelName(raw.provider, current);
  }
  return picked.model;
}

export async function selectModel(deps: AppDeps): Promise<void> {
  const raw = readRawConfig();
  const model = await pickModel(deps, raw);
  if (!model) {
    return;
  }
  if (model === raw.model) {
    void vscode.window.showInformationMessage(`当前已是模型 ${model}`);
    return;
  }
  await writeConfig({ model });
  deps.logger.info(`已切换模型：${model}`);
  deps.statusBar.setModel(model, providerLabel(raw.provider));
  deps.statusBar.idle();
  void vscode.window.showInformationMessage(`已切换到模型 ${model}`);
}

/** 只刷新列表并给出反馈，不改变当前模型 */
export async function refreshModels(deps: AppDeps): Promise<void> {
  const raw = readRawConfig();
  const apiKey = await deps.secrets.resolve(raw.provider, raw.apiKeyEnv);
  const preset = presetOf(raw.provider);

  if (!supportsModelList(raw.provider)) {
    void vscode.window.showInformationMessage(
      `${preset.label} 不支持自动获取模型列表，请运行「选择模型」手动填写。`,
    );
    return;
  }
  if (preset.requiresApiKey && !apiKey) {
    const action = await vscode.window.showWarningMessage(
      `尚未保存 ${preset.label} 的密钥，无法获取模型列表。`,
      '快速配置',
    );
    if (action === '快速配置') {
      await quickSetup(deps);
    }
    return;
  }

  const result = await fetchModelList(deps, {
    provider: raw.provider,
    baseUrl: raw.baseUrl,
    apiKey,
    reason: providerLabel(raw.provider),
  });

  if (!result.models) {
    void vscode.window
      .showErrorMessage(`获取模型列表失败：${result.error ?? '未知原因'}`, '手动输入模型')
      .then((a) => {
        if (a === '手动输入模型') {
          void vscode.commands.executeCommand('commitCraft.selectModel');
        }
      });
    return;
  }

  const current = (raw.model ?? '').trim();
  const suggested = pickDefaultModel(result.models, [
    preset.defaultModel,
    ...preset.suggestions.map((s) => s.id),
  ]);
  const action = await vscode.window.showInformationMessage(
    `已获取 ${result.models.length} 个可用模型。` +
      (!current && suggested ? `推荐使用 ${suggested}。` : ''),
    '选择模型',
    '当前模型可用',
  );
  if (action === '选择模型') {
    await vscode.commands.executeCommand('commitCraft.selectModel');
  }
}

interface SetupItem extends vscode.QuickPickItem {
  preset?: EndpointPreset;
  custom?: boolean;
}

/**
 * 快速配置向导：选服务商 → （地址）→ 密钥 → 自动获取模型 → 选默认模型 → 测试连接。
 * 目标是新用户 30 秒内从零到能生成第一条提交信息。
 */
export async function quickSetup(deps: AppDeps): Promise<void> {
  const raw = readRawConfig();
  const currentPreset = matchEndpointPreset(raw.provider, raw.baseUrl);

  const items: SetupItem[] = ENDPOINT_PRESETS.map((p) => ({
    label: `${currentPreset?.key === p.key ? '$(check) ' : ''}${p.label}`,
    description: p.description,
    detail: p.baseUrl ? `接口地址：${p.baseUrl} · 默认模型：${p.defaultModel || '—'}` : undefined,
    preset: p,
  }));
  items.push({
    label: '$(gear) 自定义 / 保持当前设置',
    description: `${providerLabel(raw.provider)} · ${raw.baseUrl || '未填写地址'}`,
    custom: true,
  });

  const picked = await vscode.window.showQuickPick<SetupItem>(items, {
    title: 'CommitCraft · 快速配置模型（1/4 选择服务商）',
    placeHolder: '选择模型服务商',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  if (picked.custom) {
    await vscode.commands.executeCommand('commitCraft.openSettings', 'model');
    return;
  }

  const preset = picked.preset!;
  let baseUrl = preset.baseUrl;

  // Azure 没有固定地址，必须问一次
  if (!baseUrl) {
    const input = await vscode.window.showInputBox({
      title: 'CommitCraft · 快速配置模型（2/4 接口地址）',
      prompt: presetOf(preset.provider).urlHint,
      placeHolder: 'https://<资源名>.openai.azure.com/openai',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const value = v.trim();
        if (!value) {
          return '接口地址不能为空';
        }
        try {
          const url = new URL(value);
          return url.protocol === 'https:' || url.protocol === 'http:' ? undefined : '必须以 http:// 或 https:// 开头';
        } catch {
          return '不是合法的 URL';
        }
      },
    });
    if (!input) {
      return;
    }
    baseUrl = input.trim().replace(/\/+$/, '');
  }

  await writeConfig({ provider: preset.provider, baseUrl });

  // 密钥
  let apiKey = await deps.secrets.resolve(preset.provider, raw.apiKeyEnv);
  if (preset.requiresApiKey) {
    const hint = preset.keyHint ? `\n获取方式：${preset.keyHint}` : '';
    const input = await vscode.window.showInputBox({
      title: `CommitCraft · 快速配置模型（3/4 API 密钥）`,
      prompt: `密钥保存在 VSCode 加密凭据库，不会写入 settings.json，也不会随设置同步${hint}`,
      placeHolder: apiKey ? '已保存密钥，留空则保持不变' : '粘贴 API 密钥',
      password: true,
      ignoreFocusOut: true,
      value: '',
      validateInput: (v) => {
        if (!v.trim()) {
          return apiKey ? undefined : '请填写 API 密钥（Ollama 等本地服务可跳过）';
        }
        return v.trim().length >= 8 ? undefined : '密钥长度看起来不对，请检查';
      },
    });
    if (input && input.trim()) {
      apiKey = input.trim();
      await deps.secrets.set(preset.provider, apiKey);
      deps.logger.info(`已保存 ${preset.provider} 的密钥（长度 ${apiKey.length}）`);
    }
    if (!apiKey) {
      void vscode.window.showWarningMessage('未填写 API 密钥，稍后可用「设置 API 密钥」补充。');
    }
  }

  // 模型：先自动获取，失败则手动输入
  let model: string | undefined;
  if (supportsModelList(preset.provider) && (!preset.requiresApiKey || apiKey)) {
    const result = await fetchModelList(deps, {
      provider: preset.provider,
      baseUrl,
      apiKey,
      reason: preset.label,
    });
    if (result.models && result.models.length > 0) {
      model = await chooseFromList(preset, result.models);
    } else if (result.error) {
      deps.logger.warn(`快速配置：自动获取模型失败，转手动输入（${result.error}）`);
    }
  } else if (preset.defaultModel) {
    const suggested = await vscode.window.showInformationMessage(
      `${preset.label} 无法自动获取模型列表，使用默认模型 ${preset.defaultModel}？`,
      '使用默认',
      '手动输入',
    );
    model = suggested === '手动输入' ? undefined : preset.defaultModel;
  }
  if (!model) {
    model = await promptModelName(preset.provider, preset.defaultModel);
  }
  if (!model) {
    return;
  }
  await writeConfig({ model });

  deps.logger.info(`快速配置完成：${preset.provider} / ${baseUrl} / ${model}`);
  deps.statusBar.setModel(model, providerLabel(preset.provider));
  deps.statusBar.idle();

  const action = await vscode.window.showInformationMessage(
    `已配置 ${preset.label} · ${model}。建议先测试一次连接。`,
    '测试连接',
    '开始使用',
  );
  if (action === '测试连接') {
    await vscode.commands.executeCommand('commitCraft.testConnection');
  }
}

/** 快速配置里的模型选择：列表 + 手动输入兜底 */
async function chooseFromList(preset: EndpointPreset, models: ModelInfo[]): Promise<string | undefined> {
  const suggested = pickDefaultModel(models, [
    preset.defaultModel,
    ...presetOf(preset.provider).suggestions.map((s) => s.id),
  ]);
  const items: ModelPickItem[] = models.map((m) => ({
    label: `${m.id === suggested ? '$(star) ' : ''}${m.id}`,
    description: [m.id === suggested ? '推荐' : undefined, m.note].filter(Boolean).join(' · ') || undefined,
    model: m.id,
  }));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(edit) 手动输入模型名称…', action: 'input' });

  const picked = await vscode.window.showQuickPick<ModelPickItem>(items, {
    title: `CommitCraft · 快速配置模型（4/4 选择默认模型，共 ${models.length} 个）`,
    placeHolder: `推荐 ${suggested ?? preset.defaultModel}`,
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.action === 'input' || !picked.model) {
    return promptModelName(preset.provider, suggested ?? preset.defaultModel);
  }
  return picked.model;
}