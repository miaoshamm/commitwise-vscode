import * as vscode from 'vscode';
import { CancellationController } from './app/cancellation';
import { AppDeps } from './app/context';
import { ModelStore } from './infra/ai/modelStore';
import { SecretStore } from './infra/config/configService';
import { NodeGitRunner } from './infra/git/gitRunner';
import { Logger } from './infra/log/logger';
import { CommitHistory } from './ui/commitHistory';
import { DiagnosticsBridge } from './ui/diagnosticsBridge';
import { ReviewStore } from './ui/reviewStore';
import { ReviewTreeProvider } from './ui/reviewTreeProvider';
import { ScmInputBridge } from './ui/scmInputBridge';
import { StatusBarController } from './ui/statusBarController';

export function createDeps(context: vscode.ExtensionContext): AppDeps {
  const logger = new Logger();
  const cancellation = new CancellationController();
  const statusBar = new StatusBarController(() => cancellation.cancel());
  const inputBridge = new ScmInputBridge((hasBackup) => {
    void vscode.commands.executeCommand('setContext', 'commitCraft.hasDraftBackup', hasBackup);
  });
  const diagnostics = new DiagnosticsBridge();
  const secrets = new SecretStore(context.secrets);
  const runner = new NodeGitRunner();
  const models = new ModelStore(context.globalState);
  const review = new ReviewStore(context.workspaceState);
  const history = new CommitHistory(context.globalState);
  const reviewView = new ReviewTreeProvider(review);

  return {
    runner,
    secrets,
    logger,
    statusBar,
    inputBridge,
    diagnostics,
    cancellation,
    models,
    review,
    history,
    reviewView,
    extensionUri: context.extensionUri,
  };
}
