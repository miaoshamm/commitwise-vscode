import * as vscode from 'vscode';

export type StatusState = 'idle' | 'collecting' | 'requesting' | 'success' | 'error';

const RESET_DELAY = 3000;

/**
 * 状态栏：
 * - 空闲：显示当前模型（点击切换），若最近有审查结果则显示问题数（点击看报告）
 * - 请求中：显示耗时，点击取消
 * - 成功/失败：短暂提示后回到空闲
 */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private state: StatusState = 'idle';
  private startedAt = 0;
  private ticker?: NodeJS.Timeout;
  private resetTimer?: NodeJS.Timeout;
  private modelLabel: string | undefined;
  private providerLabel: string | undefined;
  private reviewTotal: number | undefined;

  constructor(private readonly onCancel: () => void) {
    this.item = vscode.window.createStatusBarItem('commitCraft.status', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'CommitCraft';
    this.renderIdle();
    this.item.show();
  }

  private render(text: string, tooltip: string, command: string | undefined): void {
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.command = command;
  }

  private async setContext(key: string, value: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', key, value);
  }

  private clearTimers(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }

  /** 空闲态：同时显示当前模型与审查问题数，两个入口都不丢 */
  private renderIdle(): void {
    const brief = this.modelLabel
      ? this.modelLabel.length > 20
        ? this.modelLabel.slice(0, 19) + '…'
        : this.modelLabel
      : undefined;
    // chip = 当前模型，与「选择模型」命令同一枚图标，点开即切模型
    const modelText = brief ? `$(chip) ${brief}` : '$(chip) CommitCraft';
    const modelTip = brief
      ? `当前模型：${this.providerLabel ? this.providerLabel + ' / ' : ''}${this.modelLabel}`
      : '尚未配置模型，运行「CommitCraft: 快速配置模型」开始';

    if (this.reviewTotal !== undefined) {
      const reviewText =
        this.reviewTotal === 0 ? '$(pass) 审查无问题' : `$(checklist) ${this.reviewTotal} 个审查问题`;
      this.render(
        `${reviewText} · ${modelText}`,
        `CommitCraft\n${modelTip}\n点击查看审查报告`,
        'commitCraft.showReviewReport',
      );
      return;
    }

    this.render(modelText, `CommitCraft\n${modelTip}\n点击切换模型`, 'commitCraft.selectModel');
  }

  /** 激活时或配置变化后同步当前模型，让用户随时知道在用什么 */
  setModel(label: string | undefined, providerLabel?: string): void {
    this.modelLabel = label;
    this.providerLabel = providerLabel;
    if (this.state === 'idle') {
      this.renderIdle();
    }
  }

  /** 审查结果条数；undefined 表示"没有结果" */
  setReviewTotal(total: number | undefined): void {
    this.reviewTotal = total;
    if (this.state === 'idle') {
      this.renderIdle();
    }
  }

  startCollecting(): void {
    this.clearTimers();
    this.state = 'collecting';
    this.render('$(sync~spin) 读取暂存区…', '正在读取暂存区变更', undefined);
  }

  startRequesting(label = '生成中'): void {
    this.clearTimers();
    this.state = 'requesting';
    this.startedAt = Date.now();
    void this.setContext('commitCraft.requesting', true);

    const paint = () => {
      const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
      this.render(`$(sync~spin) ${label}… ${elapsed}s`, '点击取消请求', 'commitCraft.cancelRequest');
    };
    paint();
    this.ticker = setInterval(paint, 1000);
  }

  succeeded(text = '已生成'): void {
    this.clearTimers();
    this.state = 'success';
    void this.setContext('commitCraft.requesting', false);
    this.render(`$(check) ${text}`, '执行成功', undefined);
    this.resetTimer = setTimeout(() => this.idle(), RESET_DELAY);
  }

  failed(text = '执行失败'): void {
    this.clearTimers();
    this.state = 'error';
    void this.setContext('commitCraft.requesting', false);
    this.render(`$(warning) ${text}`, '点击查看日志', 'commitCraft.showOutput');
    this.resetTimer = setTimeout(() => this.idle(), RESET_DELAY * 2);
  }

  idle(): void {
    this.clearTimers();
    this.state = 'idle';
    void this.setContext('commitCraft.requesting', false);
    this.renderIdle();
  }

  get current(): StatusState {
    return this.state;
  }

  dispose(): void {
    this.clearTimers();
    this.item.dispose();
  }
}
