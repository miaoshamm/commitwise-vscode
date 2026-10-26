import * as vscode from 'vscode';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_RULES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, 'sk-ant-***'],
  [/\b(Authorization|api-key|x-api-key)\s*[:=]\s*.+$/gim, '$1: ***'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/g, '$1 ***'],
];

/** 写日志前统一脱敏，避免密钥/令牌经用户复制日志外泄 */
export function redactForLog(text: string): string {
  let out = text;
  for (const [re, repl] of REDACT_RULES) {
    out = out.replace(re, repl);
  }
  return out;
}

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly debugEnabled: boolean;

  constructor(name = 'CommitCraft') {
    this.channel = vscode.window.createOutputChannel(name);
    this.debugEnabled = process.env.COMMITCRAFT_DEBUG === '1';
  }

  private write(level: Level, message: string): void {
    if (level === 'debug' && !this.debugEnabled) {
      return;
    }
    const ts = new Date().toISOString().slice(11, 19);
    this.channel.appendLine(`[${ts}] [${level}] ${redactForLog(message)}`);
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, err?: unknown): void {
    this.write('error', message);
    if (err instanceof Error) {
      this.write('error', `${err.name}: ${err.message}`);
      if (this.debugEnabled && err.stack) {
        this.channel.appendLine(err.stack);
      }
    } else if (err !== undefined) {
      this.write('error', String(err));
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

export { LEVEL_ORDER };
