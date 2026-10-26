import * as vscode from 'vscode';
import { ReviewIssue, Severity } from '../domain/review/reviewIssue';
import { StoredReview } from './reviewStore';

const SEVERITY_LABEL: Record<Severity, string> = { high: '高', medium: '中', low: '低' };

const CATEGORY_LABEL: Record<string, string> = {
  bug: '缺陷',
  security: '安全',
  performance: '性能',
  style: '风格',
  maintainability: '可维护性',
  test: '测试',
  compat: '兼容性',
};

function esc(text: string | undefined): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 面板内按钮图标：内联 SVG 而非 codicon 字体。
 * Webview 想用 codicon 得把字体文件打进包里再用 asWebviewUri 加载，
 * 为一个按钮图标不值得；内联 SVG 走 currentColor，主题切换自动跟随。
 */
const ICON_COPY = `<svg class="btn-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="5.9" y="5.9" width="7.2" height="7.5" rx="1.3"/><path d="M10.3 5.9V4.2A1.4 1.4 0 0 0 8.9 2.8H4.2A1.4 1.4 0 0 0 2.8 4.2v6.3A1.4 1.4 0 0 0 4.2 11.9h1.5"/></svg>`;

const ICON_RERUN = `<svg class="btn-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.1 8a5.1 5.1 0 1 1-1.6-3.7"/><path d="M13.1 2.7v2.9h-2.9"/></svg>`;

// 外框 + 左侧竖分隔线 = 「侧边栏」的通用画法
const ICON_TREE = `<svg class="btn-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="2.7" y="2.9" width="10.6" height="10.2" rx="1.6"/><path d="M6.3 2.9v10.2"/></svg>`;


function renderIssue(issue: ReviewIssue): string {
  const locator = issue.anchor === 'line' && issue.line ? `:${issue.line}` : '';
  const suggestion = issue.suggestion ? `<pre class="suggestion">${esc(issue.suggestion)}</pre>` : '';
  return `
    <div class="issue" data-sev="${issue.severity}" data-file="${esc(issue.file)}" data-line="${issue.line ?? ''}">
      <div class="issue-head">
        <span class="badge sev-${issue.severity}">${SEVERITY_LABEL[issue.severity]}</span>
        <span class="cat">${esc(CATEGORY_LABEL[issue.category] ?? issue.category)}</span>
        <span class="loc" title="点击跳转到代码">${esc(issue.file)}${locator}</span>
      </div>
      <div class="issue-title">${esc(issue.title)}</div>
      ${issue.detail ? `<div class="issue-detail">${esc(issue.detail)}</div>` : ''}
      ${suggestion}
    </div>`;
}

function renderHtml(data: StoredReview, nonce: string): string {
  const groups =
    data.byFile.length > 0
      ? data.byFile
          .map(
            (group) => `
      <section class="file" data-file="${esc(group.file)}">
        <h3><span class="fname">${esc(group.file)}</span><span class="count">${group.issues.length}</span></h3>
        ${group.issues.map(renderIssue).join('')}
      </section>`,
          )
          .join('')
      : `<div class="empty">没有发现需要处理的问题。</div>`;

  const notices = data.notices.length
    ? `<details class="notices"><summary>审查说明（${data.notices.length}）</summary>${data.notices
        .map((n) => `<div>${esc(n)}</div>`)
        .join('')}</details>`
    : '';

  const total = data.counts.high + data.counts.medium + data.counts.low;
  const when = new Date(data.savedAt).toLocaleString('zh-CN', { hour12: false });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 0 48px;
    font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.6;
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  .wrap { padding: 18px 22px 0; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
  h3 {
    font-size: 12px; font-weight: 600; margin: 0 0 8px; display: flex; align-items: center; gap: 8px;
    position: sticky; top: 0; padding: 6px 0; background: var(--vscode-editor-background); z-index: 1;
  }
  .fname { font-family: var(--vscode-editor-font-family); }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .toolbar { display: flex; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
  button {
    font-family: inherit; font-size: 12px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 12px; border-radius: 4px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid transparent;
  }
  .btn-ico { flex: none; opacity: .85; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary {
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .chips { display: flex; gap: 8px; margin: 12px 0 16px; flex-wrap: wrap; }
  .chip {
    padding: 2px 10px; border-radius: 10px; font-size: 12px; cursor: pointer; user-select: none;
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
  }
  .chip:hover { border-color: var(--vscode-focusBorder); }
  .chip.on { outline: 1px solid var(--vscode-focusBorder); }
  .chip.high { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  .chip.medium { border-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); }
  .chip.low { border-color: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
  .summary {
    padding: 12px 14px; border-radius: 6px; margin-bottom: 14px; white-space: pre-wrap;
    background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground);
  }
  .notices {
    padding: 8px 12px; border-radius: 6px; margin-bottom: 14px; font-size: 12px;
    color: var(--vscode-descriptionForeground);
    border: 1px dashed var(--vscode-panel-border);
  }
  .notices summary { cursor: pointer; }
  .notices div { margin-top: 6px; }
  .file { margin-bottom: 22px; }
  .count {
    font-size: 11px; font-weight: 400; padding: 0 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .issue {
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    padding: 10px 12px; margin-bottom: 8px; cursor: pointer;
    background: var(--vscode-editorWidget-background);
  }
  .issue:hover { border-color: var(--vscode-focusBorder); }
  .issue-head { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 4px; }
  .badge { padding: 0 6px; border-radius: 4px; font-size: 11px; }
  .sev-high { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
  .sev-medium { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-editorWarning-foreground); }
  .sev-low { background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-descriptionForeground); }
  .cat { color: var(--vscode-descriptionForeground); }
  .loc { margin-left: auto; color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); }
  .issue-title { font-weight: 600; margin-bottom: 4px; }
  .issue-detail { color: var(--vscode-foreground); }
  .suggestion {
    margin: 8px 0 0; padding: 8px 10px; border-radius: 4px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family); font-size: 12px;
    background: var(--vscode-textCodeBlock-background);
    white-space: pre-wrap; word-break: break-word;
  }
  .empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
  .hidden { display: none !important; }
  .copy-ok { color: var(--vscode-testing-iconPassed); }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(data.repoName)} <span style="font-weight:400;color:var(--vscode-descriptionForeground)">· ${esc(data.branch)}</span></h1>
  <div class="meta">${esc(when)} · ${esc(data.providerLabel)} / ${esc(data.model)} · 用时 ${(data.elapsedMs / 1000).toFixed(1)}s</div>
  <div class="toolbar">
    <button class="primary" id="btn-copy">${ICON_COPY}<span class="lbl">复制为 Markdown</span></button>
    <button id="btn-rerun">${ICON_RERUN}<span class="lbl">重新审查暂存区</span></button>
    <button id="btn-tree">${ICON_TREE}<span class="lbl">在侧边栏查看</span></button>
  </div>
  <div class="chips">
    <span class="chip on" data-filter="all">全部 ${total}</span>
    <span class="chip high" data-filter="high">高 ${data.counts.high}</span>
    <span class="chip medium" data-filter="medium">中 ${data.counts.medium}</span>
    <span class="chip low" data-filter="low">低 ${data.counts.low}</span>
    ${data.truncated ? `<span class="chip">已截断，共 ${data.totalBeforeLimit} 条</span>` : ''}
  </div>
  ${data.summary ? `<div class="summary">${esc(data.summary)}</div>` : ''}
  ${notices}
  ${groups}
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const chip = target.closest('.chip[data-filter]');
    if (chip) {
      const filter = chip.getAttribute('data-filter');
      document.querySelectorAll('.chip[data-filter]').forEach((c) => c.classList.toggle('on', c === chip));
      document.querySelectorAll('.issue').forEach((el) => {
        const ok = filter === 'all' || el.getAttribute('data-sev') === filter;
        el.classList.toggle('hidden', !ok);
      });
      document.querySelectorAll('section.file').forEach((sec) => {
        const visible = sec.querySelectorAll('.issue:not(.hidden)').length > 0;
        sec.classList.toggle('hidden', !visible);
      });
      return;
    }

    if (target.closest('#btn-copy')) {
      vscode.postMessage({ type: 'copy' });
      return;
    }
    if (target.closest('#btn-rerun')) {
      vscode.postMessage({ type: 'rerun' });
      return;
    }
    if (target.closest('#btn-tree')) {
      vscode.postMessage({ type: 'showTree' });
      return;
    }

    const box = target.closest('.issue');
    if (!box) return;
    const file = box.getAttribute('data-file');
    const line = box.getAttribute('data-line');
    if (!file) return;
    vscode.postMessage({ type: 'goto', file, line: line ? Number(line) : undefined });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'copied') {
      const btn = document.getElementById('btn-copy');
      if (!btn) return;
      // 只换文字标签，图标和布局保持不动
      const lbl = btn.querySelector('.lbl');
      if (!lbl) return;
      const original = lbl.textContent;
      lbl.textContent = '已复制到剪贴板';
      btn.classList.add('copy-ok');
      setTimeout(() => {
        lbl.textContent = original;
        btn.classList.remove('copy-ok');
      }, 1800);
    }
  });
</script>
</body>
</html>`;
}

export interface ReviewPanelHooks {
  onCopy: (review: StoredReview) => Promise<void>;
  onRerun: () => Promise<void>;
  onShowTree: () => Promise<void>;
}

/**
 * 详细报告面板。
 *
 * 数据来自 ReviewStore，不是构造参数里的快照——这样面板重新打开时
 * 还能显示上一次的结果（关掉面板 ≠ 结果丢失）。
 */
export class ReviewPanel {
  private static current: ReviewPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly hooks: ReviewPanelHooks,
  ) {}

  static show(review: StoredReview, hooks: ReviewPanelHooks): void {
    const column = vscode.ViewColumn.Beside;
    if (ReviewPanel.current) {
      ReviewPanel.current.panel.reveal(column, true);
      ReviewPanel.current.update(review);
      return;
    }

    const panel = vscode.window.createWebviewPanel('commitCraft.review', 'CommitCraft 代码审查', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });

    const instance = new ReviewPanel(panel, hooks);
    ReviewPanel.current = instance;
    instance.update(review);

    panel.onDidDispose(() => {
      if (ReviewPanel.current === instance) {
        ReviewPanel.current = undefined;
      }
    });

    panel.webview.onDidReceiveMessage(async (msg: { type: string; file?: string; line?: number }) => {
      if (msg.type === 'goto' && msg.file) {
        const root = (ReviewPanel.lastReview ?? review).root;
        await gotoIssue({ root, file: msg.file, line: msg.line });
        return;
      }
      if (msg.type === 'copy') {
        const latest = ReviewPanel.lastReview ?? review;
        await hooks.onCopy(latest);
        void panel.webview.postMessage({ type: 'copied' });
        return;
      }
      if (msg.type === 'rerun') {
        await hooks.onRerun();
        return;
      }
      if (msg.type === 'showTree') {
        await hooks.onShowTree();
      }
    });
  }

  private static lastReview: StoredReview | undefined;

  private update(review: StoredReview): void {
    ReviewPanel.lastReview = review;
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    this.panel.webview.html = renderHtml(review, nonce);
  }

  static disposeAll(): void {
    ReviewPanel.current?.panel.dispose();
    ReviewPanel.current = undefined;
  }
}

/** 跳转到问题所在行；文件级问题落到第 1 行 */
export async function gotoIssue(target: { root: string; file: string; line?: number }): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.Uri.file(target.root), target.file);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showWarningMessage(`无法打开文件：${target.file}（可能已被移动或删除）`);
    return;
  }
  const lineIndex = Math.max(0, (target.line ?? 1) - 1);
  const position = new vscode.Position(Math.min(lineIndex, Math.max(0, doc.lineCount - 1)), 0);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(position, position),
    viewColumn: vscode.ViewColumn.One,
    preview: true,
  });
}
