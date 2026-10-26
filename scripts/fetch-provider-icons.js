/**
 * 下载设置页用的服务商图标。
 *
 * 图标来源：Lobe Icons 的静态 SVG 包（@lobehub/icons-static-svg，MIT）。
 * 之所以不直接内联到源码里：
 *   1. 图标是「品牌资产」，单独放 media/providers 便于替换，不用改 TypeScript；
 *   2. 打包时由 .vscodeignore 统一决定去留，不会混进源码。
 *
 * 统一做一次规整，让图标在 webview 里能跟随主题色：
 *   - 删掉 <title>（无障碍文字由外层 label 提供，避免重复朗读）
 *   - 去掉 width/height/style，尺寸交给 CSS 控制（否则 1em 会和字号耦合，出现大小不一致）
 *   - 根节点强制 fill="currentColor"，浅色/深色主题都能看清
 *
 * 用法：node scripts/fetch-provider-icons.js
 */
const fs = require('fs');
const path = require('path');

const PKG = '@lobehub/icons-static-svg@1.100.0';
const BASE = `https://unpkg.com/${PKG}/icons`;

/** 本地文件名 -> Lobe Icons 里的图标名 */
const ICONS = {
  deepseek: 'deepseek',
  openai: 'openai',
  qwen: 'qwen',
  moonshot: 'moonshot',
  zhipu: 'zhipu',
  ollama: 'ollama',
  anthropic: 'anthropic',
  azure: 'azure',
};

const OUT_DIR = path.join(__dirname, '..', 'media', 'providers');

function normalize(raw, name) {
  let svg = String(raw).trim();
  if (!/^<svg/i.test(svg)) {
    throw new Error(`${name} 不是 SVG`);
  }
  svg = svg
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<desc>[\s\S]*?<\/desc>/gi, '')
    // 根标签上的尺寸与行内样式一律去掉，改由 CSS 统一控制
    .replace(/(<svg\b[^>]*?)\s+width="[^"]*"/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height="[^"]*"/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+style="[^"]*"/i, '$1');

  const head = svg.match(/^<svg\b[^>]*>/i)[0];
  const rest = svg.slice(head.length);
  let attrs = head;
  if (!/\sfill="/.test(attrs)) {
    attrs = attrs.replace(/^<svg\b/i, '<svg fill="currentColor"');
  }
  if (!/\sviewBox="/.test(attrs)) {
    throw new Error(`${name} 缺少 viewBox，无法自适应缩放`);
  }
  attrs = attrs
    .replace(/\sfill-rule="[^"]*"/i, '')
    .replace(/\sxmlns="[^"]*"/i, '')
    .replace(/\saria-hidden="[^"]*"/i, '')
    .replace(/^<svg\b/i, '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"');
  return `${attrs}${rest}`;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  for (const [file, remote] of Object.entries(ICONS)) {
    const res = await fetch(`${BASE}/${remote}.svg`);
    if (!res.ok) {
      throw new Error(`下载 ${remote} 失败：HTTP ${res.status}`);
    }
    // curl 追随 302，fetch 默认也会
    const svg = normalize(await res.text(), remote);
    const target = path.join(OUT_DIR, `${file}.svg`);
    fs.writeFileSync(target, svg + '\n', 'utf8');
    written.push(`${file}.svg  ${(svg.length / 1024).toFixed(1)} KB`);
  }
  console.log(`已写入 ${written.length} 个图标到 media/providers：`);
  for (const w of written) console.log('  ' + w);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
