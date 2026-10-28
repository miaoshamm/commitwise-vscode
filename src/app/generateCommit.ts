import * as vscode from 'vscode';
import { buildCorrectionPrompt, parseCommitMessage, ParsedCommit } from '../domain/commit/messageValidator';
import { TemplateRegistry } from '../domain/prompt/builtinTemplates';
import { callModel } from '../infra/ai/callModel';
import { AiError } from '../infra/ai/types';
import { AppDeps, handleError, prepareStagedContext } from './context';
import { buildMessages, repoNameOf } from './promptBuilder';

function reportWarnings(deps: AppDeps, parsed: ParsedCommit): void {
  for (const issue of parsed.issues) {
    if (issue.severity === 'warn') {
      deps.logger.warn(`提交信息校验：${issue.message}`);
    }
  }
}

export async function generateCommitMessage(deps: AppDeps, templateIdOverride?: string): Promise<void> {
  const ctx = await prepareStagedContext(deps);
  if (!ctx) {
    return;
  }
  const { config, snapshot, prepared, repo } = ctx;

  const registry = new TemplateRegistry({ customTemplates: config.customTemplates });
  for (const w of registry.warnings) {
    deps.logger.warn(w);
  }

  const requestedId = templateIdOverride ?? config.commit.templateId;
  const { template, fellBack } = registry.resolve(requestedId, 'commit');
  if (fellBack) {
    deps.logger.warn(`模板 "${requestedId}" 不存在或类型不符，已回退到 "${template.name}"`);
    void vscode.window.showWarningMessage(`找不到可用的提交信息模板，已改用「${template.name}」。`);
  }

  const built = buildMessages(template, snapshot, prepared, config);
  if (built.missingVariables.length > 0) {
    deps.logger.warn(`模板中存在未知变量：${built.missingVariables.join('、')}（已按空值处理）`);
  }

  const parseOpts = { format: config.commit.format, maxSubjectLength: config.commit.maxSubjectLength };
  const controller = deps.cancellation.begin();

  let parsed: ParsedCommit | undefined;
  let corrected = false;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CommitCraft · 生成提交信息', cancellable: true },
      async (progress, token) => {
        const sub = token.onCancellationRequested(() => deps.cancellation.cancel());
        deps.statusBar.startRequesting('生成中');

        const streamed = { chars: 0, lastReport: 0 };
        const onDelta = (delta: string) => {
          streamed.chars += delta.length;
          const now = Date.now();
          if (now - streamed.lastReport > 200) {
            streamed.lastReport = now;
            progress.report({ message: `已接收 ${streamed.chars} 字符…` });
          }
        };

        try {
          progress.report({ message: `模板：${template.name}` });
          const first = await callModel({
            config,
            messages: built.messages,
            signal: controller.signal,
            onDelta,
            logger: deps.logger,
          });

          parsed = parseCommitMessage(first.text, parseOpts);
          deps.logger.info(`首次生成：${parsed.valid ? '通过校验' : '未通过校验'}，尝试 ${first.attempts} 次`);

          // 格式不合规时带反馈重试一次（与网络重试独立，只做一次）
          if (!parsed.valid) {
            corrected = true;
            deps.logger.warn(`输出不合规，触发纠错重试：${parsed.issues.map((i) => i.message).join('；')}`);
            progress.report({ message: '格式不合规，正在修正…' });

            const second = await callModel({
              config,
              messages: [
                ...built.messages,
                { role: 'assistant', content: first.text },
                { role: 'user', content: buildCorrectionPrompt(parsed, parseOpts) },
              ],
              signal: controller.signal,
              logger: deps.logger,
            });
            parsed = parseCommitMessage(second.text, parseOpts);
          }

          reportWarnings(deps, parsed);
        } finally {
          sub.dispose();
        }
      },
    );
  } catch (err) {
    if (err instanceof AiError && err.code === 'aborted') {
      deps.statusBar.idle();
      void vscode.window.showInformationMessage('已取消生成。');
      return;
    }
    handleError(deps, err);
    return;
  } finally {
    deps.cancellation.end(controller);
  }

  if (!parsed || !parsed.message.trim()) {
    deps.statusBar.failed();
    void vscode.window.showErrorMessage('模型没有返回可用的提交信息，请查看日志或更换模型重试。');
    return;
  }

  let message = parsed.message;

  if (config.commit.confirmBeforeInsert) {
    const edited = await vscode.window.showInputBox({
      title: '确认提交信息',
      value: message,
      prompt: corrected ? '（首次输出不合规，已自动修正）可直接编辑后写入' : '可直接编辑后写入源代码管理输入框',
      valueSelection: [0, (message.split('\n')[0] ?? '').length],
    });
    if (edited === undefined) {
      deps.statusBar.idle();
      void vscode.window.showInformationMessage('已取消写入。');
      return;
    }
    message = edited;
  }

  const outcome = deps.inputBridge.write(repo, message);
  deps.statusBar.succeeded(outcome === 'input-box' ? '已写入输入框' : '已复制');

  // 写入成功后入栈历史：误清空输入框也能从「提交信息历史」找回
  void deps.history
    .push({
      message,
      model: config.model,
      time: Date.now(),
      repoName: repoNameOf(snapshot.root),
      branch: snapshot.branch,
    })
    .catch((err) => {
      deps.logger.warn(`写入提交信息历史失败：${(err as Error)?.message ?? err}`);
    });

  if (outcome === 'input-box') {
    void vscode.window.showInformationMessage(`已写入源代码管理输入框（${message.split('\n')[0]}）`, '恢复原草稿');
  } else {
    void vscode.window.showInformationMessage('当前仓库未提供 SCM 输入框，提交信息已复制到剪贴板。');
  }

  if (!parsed.valid) {
    deps.logger.warn('两次生成均未通过格式校验，输出已按原样提供，请人工确认。');
    void vscode.window.showWarningMessage('提交信息未完全符合规范，请检查后再提交。');
  }

  if (prepared.truncated.length > 0) {
    void vscode.window.showWarningMessage(
      `部分文件内容过长已截断（${prepared.truncated.join('、')}），生成的描述可能不完整。`,
      '查看日志',
    );
  }
}
