import * as fs from 'fs';
import * as path from 'path';

/**
 * 设置页用的服务商图标。
 *
 * 图标以「内联 SVG 字符串」的形式注入 Webview，而不是 <img src>：
 *   1. 内联才能继承 currentColor，浅色/深色主题下都自动适配，不会出现白底黑字看不见；
 *   2. 不需要额外放宽 CSP 的 img-src，也不用为每个图标算 webview URI；
 *   3. 尺寸完全由 CSS 控制，避免图标自带的 width/height 与字号耦合导致大小不一。
 *
 * 资源来源：media/providers/*.svg（Lobe Icons 静态 SVG 包，MIT）。
 * 缺文件时退回一个通用占位图标，绝不因为缺图标让整页渲染失败。
 */
export const PROVIDER_ICON_KEYS = [
  'deepseek',
  'openai',
  'qwen',
  'moonshot',
  'zhipu',
  'ollama',
  'anthropic',
  'azure',
  'compatible',
] as const;

export type ProviderIconKey = (typeof PROVIDER_ICON_KEYS)[number];

/** 「OpenAI 兼容接口」不是一个具体厂商，用一对尖括号表示「任意兼容端点」 */
const COMPATIBLE_ICON =
  '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">' +
  '<path d="M8.5 6.5 3.5 12l5 5.5"/><path d="M15.5 6.5 20.5 12l-5 5.5"/></svg>';

/** 服务商类型（请求协议）对应的图标：协议层没有品牌，尽量复用同一家的标志 */
export const PROVIDER_TYPE_ICON: Record<string, ProviderIconKey> = {
  'openai-compatible': 'compatible',
  anthropic: 'anthropic',
  'azure-openai': 'azure',
  ollama: 'ollama',
};

export function loadProviderIcons(extensionPath: string): Record<string, string> {
  const dir = path.join(extensionPath, 'media', 'providers');
  const icons: Record<string, string> = { compatible: COMPATIBLE_ICON };
  for (const key of PROVIDER_ICON_KEYS) {
    if (key === 'compatible') {
      continue;
    }
    try {
      const svg = fs.readFileSync(path.join(dir, `${key}.svg`), 'utf8').trim();
      icons[key] = /^<svg/i.test(svg) ? svg : COMPATIBLE_ICON;
    } catch {
      // 打包时漏掉某个 SVG 也要能用，只是少一个图标
      icons[key] = COMPATIBLE_ICON;
    }
  }
  return icons;
}
