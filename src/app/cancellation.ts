/** 全局只允许一个进行中的请求，重复触发会取消上一次 */
export class CancellationController {
  private current?: AbortController;

  begin(): AbortController {
    this.cancel();
    this.current = new AbortController();
    return this.current;
  }

  cancel(): boolean {
    if (this.current && !this.current.signal.aborted) {
      this.current.abort();
      return true;
    }
    return false;
  }

  end(controller: AbortController): void {
    if (this.current === controller) {
      this.current = undefined;
    }
  }

  get active(): boolean {
    return !!this.current && !this.current.signal.aborted;
  }
}
