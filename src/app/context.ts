import * as vscode from 'vscode';
import { PreparedDiff, prepareDiff } from '../domain/diff/prepareDiff';
import { loadConfig, readRawConfig, SecretStore } from '../infra/config/configService';
import { PROVIDER_LABELS, ResolvedConfig } from '../infra/config/configTypes';
import { ModelStore } from '../infra/ai/modelStore';
import { collectStaged, StagedSnapshot } from '../infra/git/diffCollector';
import { GitError, GitRunner, GitUnavailableError } from '../infra/git/gitRunner';
import { pickRepository, RepoHandle } from '../infra/git/repoLocator';
import { Logger } from '../infra/log/logger';
import { CommitHistory } from '../ui/commitHistory';
import { DiagnosticsBridge } from '../ui/diagnosticsBridge';
import { ReviewStore } from '../ui/reviewStore';
import { ReviewTreeProvider } from '../ui/reviewTreeProvider';
import { ScmInputBridge } from '../ui/scmInputBridge';
import { StatusBarController } from '../ui/statusBarController';
import { CancellationController } from './cancellation';

export interface AppDeps {
  runner: GitRunner;
  secrets: SecretStore;
  logger: Logger;
  statusBar: StatusBarController;
  inputBridge: ScmInputBridge;
  diagnostics: DiagnosticsBridge;
  cancellation: CancellationController;
  /** 模型列表缓存（自动获取的结果） */
  models: ModelStore;
  /** 最近一次审查结果的唯一来源 */
  review: ReviewStore;
  /** 最近生成过的提交信息（环形，最多 10 条） */
  history: CommitHistory;
  /** 侧边栏问题清单 */
  reviewView: ReviewTreeProvider;
  extensionUri: vscode.Uri;
}

export interface StagedContext {
  repo: RepoHandle;
  snapshot: StagedSnapshot;
  config: ResolvedConfig;
  prepared: PreparedDiff;
}

/**
 * 两个用例共用的前置流程：定位仓库 → 采集暂存区 → 校验配置 → 过滤裁剪。
 * 任何一步不满足都给出面向用户的中文提示并返回 undefined（不抛异常）。
 */
export async function prepareStagedContext(deps: AppDeps): Promise<StagedContext | undefined> {
  let repo: RepoHandle | undefined;
  try {
    deps.statusBar.startCollecting();
    repo = await pickRepository(deps.runner);
  } catch (err) {
    handleError(deps, err);
    return undefined;
  }

  if (!repo) {
    deps.statusBar.idle();
    void vscode.window.showWarningMessage('没有找到 Git 仓库，请先在工作区中打开一个 Git 项目。');
    return undefined;
  }

  let snapshot: StagedSnapshot;
  try {
    // 先用原始配置（未校验）取最近提交条数，避免为一个展示参数提前跑整套校验
    const rawForCollect = readRawConfig(vscode.Uri.file(repo.root));
    snapshot = await collectStaged(deps.runner, repo.root, rawForCollect.commit.recentCommitCount);
  } catch (err) {
    handleError(deps, err);
    return undefined;
  }

  if (snapshot.files.length === 0) {
    deps.statusBar.idle();
    void vscode.window.showWarningMessage('暂存区没有变更。请先执行 git add 暂存要提交的文件。');
    return undefined;
  }

  const loaded = await loadConfig(deps.secrets, vscode.Uri.file(repo.root));
  deps.logger.debug(`配置校验：${loaded.validation.errors.length} 错误，${loaded.validation.warnings.length} 警告`);

  if (loaded.validation.errors.length > 0 || !loaded.config) {
    deps.statusBar.idle();
    const action = await vscode.window.showErrorMessage(
      `CommitCraft 配置有误：${loaded.validation.errors[0]}`,
      '快速配置',
      '打开设置',
    );
    if (action === '快速配置') {
      await vscode.commands.executeCommand('commitCraft.quickSetup');
    } else if (action === '打开设置') {
      await vscode.commands.executeCommand('commitCraft.openSettings');
    }
    return undefined;
  }

  const config = loaded.config;

  // 模型名留空时已回填推荐默认值，明确告知用户用的是哪个
  if (loaded.validation.modelDefaulted) {
    deps.logger.warn(`未配置模型，已使用推荐默认模型 ${loaded.validation.modelDefaulted}`);
    void vscode.window
      .showInformationMessage(
        `尚未配置模型，本次使用推荐默认模型 ${loaded.validation.modelDefaulted}。`,
        '选择模型',
      )
      .then((action) => {
        if (action === '选择模型') {
          void vscode.commands.executeCommand('commitCraft.selectModel');
        }
      });
  }

  if (!config.apiKey && config.provider !== 'ollama') {
    deps.statusBar.idle();
    const action = await vscode.window.showWarningMessage(
      `尚未设置 ${PROVIDER_LABELS[config.provider]} 的 API 密钥。`,
      '快速配置',
      '仅设置密钥',
    );
    if (action === '快速配置') {
      await vscode.commands.executeCommand('commitCraft.quickSetup');
    } else if (action === '仅设置密钥') {
      await vscode.commands.executeCommand('commitCraft.setApiKey');
    }
    return undefined;
  }

  if (loaded.validation.warnings.length > 0) {
    for (const w of loaded.validation.warnings) {
      deps.logger.warn(w);
    }
  }

  const prepared = prepareDiff(snapshot.files, {
    excludeGlobs: config.diff.excludeGlobs,
    maxFileChars: config.diff.maxFileChars,
    maxTotalChars: config.diff.maxTotalChars,
    redactSecrets: config.diff.redactSecrets,
  });

  deps.logger.info(
    `暂存区：${snapshot.files.length} 个文件，补丁 ${snapshot.rawPatchChars} 字符 → 发送 ${prepared.chars} 字符` +
      (prepared.skipped.length > 0 ? `，跳过 ${prepared.skipped.length} 个：${prepared.skipped.map((s) => s.path).join(', ')}` : ''),
  );
  if (prepared.redactionHits > 0) {
    deps.logger.warn(`已脱敏 ${prepared.redactionHits} 处疑似密钥（${prepared.redactionRules.join(', ')}）`);
  }

  if (!prepared.patch.trim()) {
    deps.statusBar.idle();
    void vscode.window.showWarningMessage(
      '暂存区中的变更全部被排除规则过滤掉了（例如只有 lockfile 或构建产物）。请在设置中调整 commitCraft.diff.excludeGlobs。',
    );
    return undefined;
  }

  return { repo, snapshot, config, prepared };
}

export function handleError(deps: AppDeps, err: unknown): void {
  deps.statusBar.failed();

  if (err instanceof GitUnavailableError) {
    void vscode.window.showErrorMessage(err.message);
    deps.logger.error('git 不可用');
    return;
  }
  if (err instanceof GitError) {
    void vscode.window.showErrorMessage(err.message);
    deps.logger.error(err.message, err);
    return;
  }
  if (err && typeof err === 'object' && 'toUserMessage' in err && typeof (err as { toUserMessage: () => string }).toUserMessage === 'function') {
    const msg = (err as { toUserMessage: () => string }).toUserMessage();
    deps.logger.error(msg, err);
    void vscode.window.showErrorMessage(msg, '查看日志').then((action) => {
      if (action === '查看日志') {
        deps.logger.show();
      }
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  deps.logger.error(message, err);
  void vscode.window.showErrorMessage(`CommitCraft 执行失败：${message}`, '查看日志').then((action) => {
    if (action === '查看日志') {
      deps.logger.show();
    }
  });
}
