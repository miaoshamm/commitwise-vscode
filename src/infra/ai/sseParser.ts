export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

const SEPARATOR = /\r?\n\r?\n/;

/**
 * 增量 SSE 解析器：跨 chunk 边界安全。
 *
 * 不假设 TCP 分片与事件边界对齐——实际测试中同一事件经常被拆成多个 chunk，
 * 多个事件也可能挤在一个 chunk 里。
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    for (;;) {
      const m = SEPARATOR.exec(this.buffer);
      if (!m) {
        break;
      }
      const raw = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = parseFrame(raw);
      if (ev) {
        events.push(ev);
      }
    }

    return events;
  }

  /** 流结束时调用：把没有以空行收尾的残留帧也吐出来 */
  flush(): SseEvent[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) {
      return [];
    }
    const ev = parseFrame(rest);
    return ev ? [ev] : [];
  }
}

function parseFrame(raw: string): SseEvent | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'event') {
      event = value;
    } else if (field === 'id') {
      id = value;
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }
  return { event, data: dataLines.join('\n'), id };
}

/** NDJSON（Ollama /api/chat 使用）逐行解析 */
export class NdjsonParser {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) {
        break;
      }
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      try {
        out.push(JSON.parse(line));
      } catch {
        // 单行损坏不影响后续行；调用方通过 flush 处理尾部
      }
    }
    return out;
  }

  flush(): unknown[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) {
      return [];
    }
    try {
      return [JSON.parse(rest)];
    } catch {
      return [];
    }
  }
}
