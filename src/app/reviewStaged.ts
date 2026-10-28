import * as vscode from 'vscode';
import { mapIssuesToDiff } from '../domain/review/issueMapper';
import { parseReviewResponse } from '../domain/review/reviewIssue';
import { TemplateRegistry } from '../domain/prompt/builtinTemplates';
import { callModel } from '../infra/ai/callModel';
import { AiError } from '../infra/ai/types';
import { PROVIDER_LABELS } from '../infra/config/providers';
import { ReviewPanel } from '../ui/reviewPanel';
import { StoredReview } from '../ui/reviewStore';
import { AppDeps, handleError, prepareStagedContext } from './context';
import { buildMessages, buildReviewRepairMessage, repoNameOf } from './promptBuilder';
import { reviewPanelHooks } from './reviewHooks';

export async function reviewStagedChanges(deps: AppDeps): Promise<void> {
  // 重复触发会打断进行中的审查（CancellationController 会取消上一个请求），直接拦下
  if (deps.review.isRunning()) {
    void vscode.window.showWarningMessage('审查正在进行中，请等当前审查完成后再操作。');
    return;
  }

  const ctx = await prepareStagedContext(deps);
  if (!ctx) {
    return;
  }
  const { config, snapshot, prepared, repo } = ctx;

  const registry = new TemplateRegistry({ customTemplates: config.customTemplates });
  for (const w of registry.warnings) {
    deps.logger.warn(w);
  }

  const { template, fellBack } = registry.resolve(config.review.templateId, 'review');
  if (fellBack) {
    deps.logger.warn(`找不到审查模板 "${config.review.templateId}"，已回退到 "${template.name}"`);
  }

  const built = buildMessages(template, snapshot, prepared, config);
  const controller = deps.cancellation.begin();
  const startedAt = Date.now();

  // 运行态先落库：侧边栏与已打开的报告面板立即显示「审查中」并禁用重复触发
  deps.review.setRunning(true);

  let outcome: ReturnType<typeof parseReviewResponse> | undefined;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CommitCraft · 审查暂存区代码', cancellable: true },
      async (progress, token) => {
        const sub = token.onCancellationRequested(() => deps.cancellation.cancel());
        deps.statusBar.startRequesting('审查中');

        let chars = 0;
        let lastReport = 0;
        const onDelta = (delta: string) => {
          chars += delta.length;
          const now = Date.now();
          if (now - lastReport > 200) {
            lastReport = now;
            progress.report({ message: `已接收 ${chars} 字符…` });
          }
        };

        try {
          progress.report({ message: `模板：${template.name}` });
          const first = await callModel({
            config,
            messages: built.messages,
            signal: controller.signal,
            onDelta,
            maxTokens: Math.max(config.maxTokens, 2048),
            logger: deps.logger,
          });

          outcome = parseReviewResponse(first.text);
          deps.logger.info(
            `审查响应：${first.text.length} 字符，解析${outcome.result ? '成功' : '失败'}${outcome.repaired ? '（已自动修复 JSON）' : ''}`,
          );

          if (!outcome.result) {
            deps.logger.warn(`JSON 解析失败，触发修复重试：${outcome.error ?? '未知原因'}`);
            progress.report({ message: '返回格式不合法，正在要求模型重新输出…' });

            const second = await callModel({
              config,
              messages: [
                ...built.messages,
                { role: 'assistant', content: first.text },
                { role: 'user', content: buildReviewRepairMessage(first.text) },
              ],
              signal: controller.signal,
              maxTokens: Math.max(config.maxTokens, 2048),
              logger: deps.logger,
            });
            outcome = parseReviewResponse(second.text);

            if (!outcome.result) {
              deps.logger.error(`两次均无法解析模型输出，原始内容：\n${second.text.slice(0, 2000)}`);
            }
          }
        } finally {
          sub.dispose();
        }
      },
    );
  } catch (err) {
    if (err instanceof AiError && err.code === 'aborted') {
      deps.statusBar.idle();
      void vscode.window.showInformationMessage('已取消审查。');
      return;
    }
    handleError(deps, err);
    return;
  } finally {
    deps.cancellation.end(controller);
    // 成功、失败、取消都会走到这里：运行态必须复位，否则面板按钮永远禁用
    deps.review.setRunning(false);
  }

  if (!outcome?.result) {
    deps.statusBar.failed();
    void vscode.window
      .showErrorMessage('模型返回的内容无法解析为审查结果，已把原始输出写入日志。', '查看日志')
      .then((action) => {
        if (action === '查看日志') {
          deps.logger.show();
        }
      });
    return;
  }

  const mapped = mapIssuesToDiff(outcome.result, snapshot.files, outcome.dropped, {
    minSeverity: config.review.minSeverity,
    maxIssues: config.review.maxIssues,
  });

  const notices: string[] = [];
  if (mapped.dropped.unknownFile > 0) {
    notices.push(`${mapped.dropped.unknownFile} 条问题指向的文件不在本次暂存区中，已忽略（可能由模型臆造）。`);
  }
  if (mapped.dropped.outOfRange > 0) {
    notices.push(`${mapped.dropped.outOfRange} 条问题的行号不在新增行范围内，已降级为文件级问题。`);
  }
  if (mapped.dropped.malformed > 0) {
    notices.push(`${mapped.dropped.malformed} 条问题缺少必要字段，已丢弃。`);
  }
  if (mapped.truncated) {
    notices.push(`共 ${mapped.totalBeforeLimit} 条问题，按设置仅展示前 ${mapped.issues.length} 条。`);
  }
  if (prepared.truncated.length > 0) {
    notices.push(`以下文件内容过长已截断，其问题可能未被发现：${prepared.truncated.join('、')}。`);
  }
  if (prepared.skipped.length > 0) {
    notices.push(`以下文件未参与审查：${prepared.skipped.map((s) => s.path).join('、')}。`);
  }

  const total = mapped.counts.high + mapped.counts.medium + mapped.counts.low;
  const elapsedMs = Date.now() - startedAt;

  if (config.review.showDiagnostics) {
    const touched = deps.diagnostics.apply(repo.root, mapped.issues);
    deps.logger.info(`已在 ${touched} 个文件中标记问题`);
  } else {
    deps.diagnostics.clear();
  }

  // 结果先落库：侧边栏、状态栏、报告面板全都读这一份，关掉面板也不会丢
  const stored: StoredReview = {
    savedAt: Date.now(),
    root: repo.root,
    repoName: repoNameOf(snapshot.root),
    branch: snapshot.branch,
    providerLabel: PROVIDER_LABELS[config.provider],
    model: config.model,
    elapsedMs,
    summary: mapped.summary,
    issues: mapped.issues,
    byFile: mapped.byFile,
    counts: mapped.counts,
    notices,
    truncated: mapped.truncated,
    totalBeforeLimit: mapped.totalBeforeLimit,
  };
  await deps.review.save(stored);
  deps.statusBar.setReviewTotal(total);

  ReviewPanel.show(stored, reviewPanelHooks(deps));

  deps.logger.info(
    `审查完成：${total} 条（高 ${mapped.counts.high} / 中 ${mapped.counts.medium} / 低 ${mapped.counts.low}），用时 ${(elapsedMs / 1000).toFixed(1)}s`,
  );

  if (total === 0) {
    deps.statusBar.succeeded('未发现问题');
    void vscode.window.showInformationMessage('审查完成，未发现明显问题。');
    return;
  }

  deps.statusBar.succeeded(`${total} 条问题`);
  const action = await vscode.window.showInformationMessage(
    `审查完成：${total} 个问题（高 ${mapped.counts.high} / 中 ${mapped.counts.medium} / 低 ${mapped.counts.low}），已在侧边栏列出。`,
    '打开报告',
    '复制为 Markdown',
  );
  if (action === '打开报告') {
    ReviewPanel.show(stored, reviewPanelHooks(deps));
  } else if (action === '复制为 Markdown') {
    await vscode.commands.executeCommand('commitCraft.copyReviewMarkdown');
  }
}
