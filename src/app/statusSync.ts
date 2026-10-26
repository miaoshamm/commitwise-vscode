import * as vscode from 'vscode';
import { readRawConfig } from '../infra/config/configService';
import { PROVIDER_LABELS, ProviderId } from '../infra/config/providers';
import { presetOf } from '../infra/config/providerPresets';
import { totalOf } from '../ui/reviewStore';
import { AppDeps } from './context';

/**
 * 把配置与审查结果同步到状态栏和 context key。
 *
 * 状态栏是用户唯一随时可见的位置，必须让它同时回答两个问题：
 * 「我现在用的是哪个模型」和「刚才的审查结果去哪看了」。
 */
export function syncStatusBar(deps: AppDeps): void {
  const raw = readRawConfig();
  const preset = presetOf(raw.provider);
  const model = (raw.model ?? '').trim() || preset.defaultModel || undefined;
  deps.statusBar.setModel(model, PROVIDER_LABELS[raw.provider as ProviderId] ?? raw.provider);

  const review = deps.review.get();
  deps.statusBar.setReviewTotal(review ? totalOf(review.counts) : undefined);
}

export async function syncReviewContext(deps: AppDeps): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'commitCraft.hasReview', !!deps.review.get());
}

/**
 * 首次使用引导：只提示一次。
 * 判断依据是「模型还是默认值 + 没有密钥」，不弹第二次靠 globalState 标记。
 */
export async function maybeShowOnboarding(deps: AppDeps, globalState: vscode.Memento): Promise<void> {
  const flag = globalState.get<boolean>('commitCraft.onboarded');
  if (flag) {
    return;
  }
  const raw = readRawConfig();
  const preset = presetOf(raw.provider);
  const apiKey = await deps.secrets.resolve(raw.provider, raw.apiKeyEnv);
  if (apiKey || !preset.requiresApiKey) {
    await globalState.update('commitCraft.onboarded', true);
    return;
  }

  await globalState.update('commitCraft.onboarded', true);
  const action = await vscode.window.showInformationMessage(
    'CommitCraft 还没配置模型。可以用「快速配置」一次完成：选服务商 → 填密钥 → 自动获取模型列表。',
    '快速配置',
    '以后再配',
  );
  if (action === '快速配置') {
    await vscode.commands.executeCommand('commitCraft.quickSetup');
  }
}
