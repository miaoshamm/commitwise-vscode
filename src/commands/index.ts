import * as vscode from 'vscode';
import { TemplateRegistry } from '../domain/prompt/builtinTemplates';
import { loadConfig, readRawConfig } from '../infra/config/configService';
import { PROVIDER_LABELS, PROVIDER_IDS, ProviderId } from '../infra/config/providers';
import { GitError, GitUnavailableError } from '../infra/git/gitRunner';
import { pickRepository } from '../infra/git/repoLocator';
import { generateCommitMessage } from '../app/generateCommit';
import { reviewStagedChanges } from '../app/reviewStaged';
import { AppDeps } from '../app/context';
import { pingModel } from '../infra/ai/callModel';
import { AiError } from '../infra/ai/types';
import { quickSetup, refreshModels, selectModel } from './modelCommands';
import { clearReview, copyReviewMarkdown, openIssueAt, revealReviewView, showReviewReport } from './reviewCommands';
import { SettingsPanel } from '../ui/settingsPanel';

function wrap(fn: (...args: any[]) => Promise<void>, deps: AppDeps) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof AiError) {
        void vscode.window.showErrorMessage(err.toUserMessage(), '查看日志');
        deps.statusBar.failed();
      } else if (err instanceof GitUnavailableError || err instanceof GitError) {
        void vscode.window.showErrorMessage(err.message);
      } else {
        deps.logger.error((err as Error)?.message ?? String(err), err);
        void vscode.window.showErrorMessage(`CommitCraft 执行失败：${(err as Error)?.message ?? err}`, '查看日志');
      }
    }
  };
}

async function pickCommitTemplate(deps: AppDeps): Promise<string | undefined> {
  const raw = readRawConfig();
  const registry = new TemplateRegistry({ customTemplates: raw.customTemplates });
  const items = registry.list('commit').map((t) => ({
    label: t.id === raw.commit.templateId ? `$(check) ${t.name}` : `      ${t.name}`,
    description: t.builtin ? '内置' : '自定义',
    detail: t.description,
    id: t.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择生成提交信息所用的模板',
    matchOnDetail: true,
  });
  return picked?.id;
}

async function setApiKey(deps: AppDeps): Promise<void> {
  const raw = readRawConfig();

  const picked = await vscode.window.showQuickPick(
    PROVIDER_IDS.map((id) => ({
      label: PROVIDER_LABELS[id],
      description: id === raw.provider ? '当前服务商' : '',
      id,
    })),
    { placeHolder: '为哪个服务商设置 API 密钥' },
  );
  if (!picked) {
    return;
  }
  const provider: string = picked.id;

  if (provider === 'ollama') {
    void vscode.window.showInformationMessage('Ollama 为本地服务，无需 API 密钥。', '获取模型列表').then((a) => {
      if (a === '获取模型列表') {
        void vscode.commands.executeCommand('commitCraft.refreshModels');
      }
    });
    return;
  }

  const value = await vscode.window.showInputBox({
    title: `${PROVIDER_LABELS[provider as ProviderId]} API 密钥`,
    prompt: '密钥保存在 VSCode 加密凭据库，不会写入 settings.json，也不会随设置同步',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length >= 8 ? undefined : '密钥长度看起来不对，请检查'),
  });
  if (!value) {
    return;
  }

  await deps.secrets.set(provider, value);
  deps.logger.info(`已保存 ${provider} 的 API 密钥（长度 ${value.trim().length}）`);

  const action = await vscode.window.showInformationMessage(
    `已保存 ${PROVIDER_LABELS[provider as ProviderId]} 的密钥。`,
    '获取模型列表',
    '测试连接',
  );
  if (action === '获取模型列表') {
    await vscode.commands.executeCommand('commitCraft.refreshModels');
  } else if (action === '测试连接') {
    await vscode.commands.executeCommand('commitCraft.testConnection');
  }
}

async function clearApiKey(deps: AppDeps): Promise<void> {
  const raw = readRawConfig();
  const confirmed = await vscode.window.showWarningMessage(
    `确定要清除 ${PROVIDER_LABELS[raw.provider as ProviderId] ?? raw.provider} 的 API 密钥吗？`,
    { modal: true },
    '清除',
  );
  if (confirmed !== '清除') {
    return;
  }
  await deps.secrets.clear(raw.provider);
  deps.logger.info(`已清除 ${raw.provider} 的密钥`);
  void vscode.window.showInformationMessage('密钥已清除。');
}

async function testConnection(deps: AppDeps): Promise<void> {
  const loaded = await loadConfig(deps.secrets);
  if (!loaded.config) {
    const action = await vscode.window.showErrorMessage(
      `配置有误：${loaded.validation.errors[0] ?? '未知错误'}`,
      '快速配置',
      '打开设置',
    );
    if (action === '快速配置') {
      await vscode.commands.executeCommand('commitCraft.quickSetup');
    } else if (action === '打开设置') {
      await vscode.commands.executeCommand('commitCraft.openSettings');
    }
    return;
  }
  const cfg = loaded.config;
  if (!cfg.apiKey && cfg.provider !== 'ollama') {
    const action = await vscode.window.showWarningMessage('尚未设置 API 密钥。', '快速配置', '仅设置密钥');
    if (action === '快速配置') {
      await vscode.commands.executeCommand('commitCraft.quickSetup');
    } else if (action === '仅设置密钥') {
      await vscode.commands.executeCommand('commitCraft.setApiKey');
    }
    return;
  }

  deps.statusBar.startRequesting('测试连接');
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CommitCraft · 测试连接', cancellable: true },
      async (_progress, token) => {
        const controller = deps.cancellation.begin();
        token.onCancellationRequested(() => deps.cancellation.cancel());
        try {
          return await pingModel(cfg, controller.signal);
        } finally {
          deps.cancellation.end(controller);
        }
      },
    );
    deps.statusBar.succeeded('连接正常');
    deps.logger.info(`连接测试成功：${result.ms}ms，响应「${result.sample}」`);
    void vscode.window.showInformationMessage(
      `连接成功（${result.ms}ms）· ${PROVIDER_LABELS[cfg.provider]} / ${cfg.model} · 响应：${result.sample || '(空)'}`,
    );
  } catch (err) {
    deps.statusBar.failed('连接失败');
    const msg = err instanceof AiError ? err.toUserMessage() : (err as Error).message;
    deps.logger.error(`连接测试失败：${msg}`, err);
    const action = await vscode.window.showErrorMessage(msg, '查看日志', '切换模型');
    if (action === '查看日志') {
      deps.logger.show();
    } else if (action === '切换模型') {
      await vscode.commands.executeCommand('commitCraft.selectModel');
    }
  }
}

async function restoreDraft(deps: AppDeps): Promise<void> {
  const repo = await pickRepository(deps.runner);
  if (!repo) {
    return;
  }
  if (!deps.inputBridge.hasBackup(repo.root)) {
    void vscode.window.showInformationMessage('没有可恢复的草稿。');
    return;
  }
  const restored = deps.inputBridge.restore(repo);
  if (restored) {
    void vscode.window.showInformationMessage('已恢复生成前的提交信息草稿。');
  }
}

/** 设置页：所有配置的主入口 */
function openSettingsPage(context: vscode.ExtensionContext, deps: AppDeps, section?: string): void {
  SettingsPanel.show(context, deps, section);
}

/** 原生设置界面，给想直接改 settings.json / 做团队共享配置的用户留的口子 */
async function openNativeSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:commitcraft.commit-craft');
}

export function registerCommands(context: vscode.ExtensionContext, deps: AppDeps): void {
  const register = (id: string, handler: (...args: any[]) => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, wrap(handler, deps)));
  };

  // 生成
  register('commitCraft.generateCommitMessage', () => generateCommitMessage(deps));
  register('commitCraft.generateWithTemplate', async () => {
    const id = await pickCommitTemplate(deps);
    if (id) {
      await generateCommitMessage(deps, id);
    }
  });

  // 审查
  register('commitCraft.reviewStagedChanges', () => reviewStagedChanges(deps));
  register('commitCraft.showReviewReport', () => showReviewReport(deps));
  register('commitCraft.copyReviewMarkdown', () => copyReviewMarkdown(deps));
  register('commitCraft.revealReviewView', () => revealReviewView());
  register('commitCraft.clearReview', () => clearReview(deps));
  register('commitCraft.goToIssue', (args) => openIssueAt(args));

  // 模型配置
  register('commitCraft.quickSetup', () => quickSetup(deps));
  register('commitCraft.selectModel', () => selectModel(deps));
  register('commitCraft.refreshModels', () => refreshModels(deps));
  register('commitCraft.setApiKey', () => setApiKey(deps));
  register('commitCraft.clearApiKey', () => clearApiKey(deps));
  register('commitCraft.testConnection', () => testConnection(deps));

  // 其他
  register('commitCraft.cancelRequest', async () => {
    const cancelled = deps.cancellation.cancel();
    if (cancelled) {
      deps.logger.info('用户取消了当前请求');
    }
  });
  register('commitCraft.restoreDraft', () => restoreDraft(deps));
  // 可选参数是分区 id（model / commit / review / context / advanced），用于从别处深链到某一页
  register('commitCraft.openSettings', async (section?: string) => openSettingsPage(context, deps, section));
  register('commitCraft.openSettingsPage', async (section?: string) => openSettingsPage(context, deps, section));
  register('commitCraft.openNativeSettings', () => openNativeSettings());
  register('commitCraft.showOutput', async () => {
    deps.logger.show();
  });
  register('commitCraft.clearDiagnostics', async () => {
    deps.diagnostics.clear();
    void vscode.window.showInformationMessage('已清除审查标记。');
  });
}
