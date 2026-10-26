#!/usr/bin/env node
/**
 * CommitCraft 发布流水线（开发计划 §6 发布流程的代码化版本）
 *
 * 用法：
 *   node scripts/publish.js --check                仅做发布前检查（§6.2 清单）
 *   node scripts/publish.js --dry-run              检查 + 校验 + 打包，但不推送
 *   node scripts/publish.js --pre-release          推送到 Marketplace 预发布渠道
 *   node scripts/publish.js                        正式发布（Marketplace + Open VSX）
 *   node scripts/publish.js --target vsix          只产出 .vsix
 *
 * 令牌（不要写进任何文件，只放环境变量）：
 *   VSCE_PAT   Azure DevOps PAT，需 Marketplace → Manage 权限
 *   OVSX_PAT   open-vsx.org 访问令牌
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[36m',
};

const results = [];
const add = (level, label, detail) => results.push({ level, label, detail });

function step(msg) {
  console.log(`\n${C.blue}▸${C.reset} ${C.bold}${msg}${C.reset}`);
}

function ok(msg) {
  console.log(`  ${C.green}✓${C.reset} ${msg}`);
}

function warn(msg) {
  console.log(`  ${C.yellow}!${C.reset} ${msg}`);
}

function fail(msg) {
  console.log(`  ${C.red}✗${C.reset} ${msg}`);
}

function info(msg) {
  console.log(`  ${C.dim}·${C.reset} ${msg}`);
}

function bin(name) {
  const base = path.join(ROOT, 'node_modules', '.bin', name);
  if (process.platform === 'win32') return `${base}.cmd`;
  return base;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${path.basename(cmd)} 执行失败（退出码 ${res.status}）`);
  }
  return res;
}

/* ------------------------------------------------------------------ 参数解析 */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const valueOf = (name, fallback = '') => {
  // 同时支持 --target=vsix 与 --target vsix 两种写法
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
};

const MODE = flags.has('--check') ? 'check' : flags.has('--dry-run') ? 'dry-run' : 'publish';
const PRE_RELEASE = flags.has('--pre-release');
const TARGET = valueOf('target', 'all');
const SKIP_VERIFY = flags.has('--skip-verify');
const SKIP_DUPLICATE = flags.has('--skip-duplicate') || true; // 幂等：同版本重复推送不视为失败

/* -------------------------------------------------------------- §6.2 检查项 */

function checkVersion() {
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    add('blocker', '版本号', `package.json 的 version「${pkg.version}」不是 MAJOR.MINOR.PATCH`);
    return;
  }
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const hasEntry = changelog.includes(`## ${pkg.version}`) || changelog.includes(`## [${pkg.version}]`);
  if (!hasEntry) add('blocker', 'CHANGELOG', `缺少 ${pkg.version} 的版本段落`);
  else add('ok', '版本号', `${pkg.version}，CHANGELOG 有对应段落`);
}

function checkEngines() {
  const types = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@types/vscode/package.json'), 'utf8'));
  const apiVersion = types.version;
  const declared = (pkg.engines && pkg.engines.vscode) || '';
  add('ok', 'engines.vscode', `${declared}（@types/vscode ${apiVersion}）`);
  const want = apiVersion.replace(/\.\d+$/, '');
  if (!declared.includes(want)) {
    add('warn', 'engines.vscode', `与 @types/vscode ${apiVersion} 的主次版本不一致，可能用到未支持 API`);
  }
}

function checkPublisher() {
  if (!pkg.publisher) {
    add('blocker', 'publisher', '未设置 publisher，Marketplace 无法确定归属');
    return;
  }
  if (pkg.publisher !== pkg.publisher.toLowerCase()) {
    add('warn', 'publisher', 'publisher 建议全小写（Marketplace ID 大小写不敏感但 URL 用它）');
  }
  add('ok', 'publisher', pkg.publisher);
}

function checkRepo() {
  const repo = pkg.repository;
  if (!repo) {
    add('warn', 'repository', '未填写 repository：Marketplace 上的 README 相对图片、源码链接、Issue 入口都不会生效');
    return;
  }
  add('ok', 'repository', typeof repo === 'string' ? repo : repo.url);
  if (!pkg.bugs) add('warn', 'bugs', '未填写 bugs，用户点「报告问题」会去仓库首页');
  else add('ok', 'bugs', typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs.url);
}

function checkLicense() {
  if (!pkg.license) add('blocker', 'license', 'package.json 缺少 license 字段');
  else if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) add('blocker', 'license', '缺少 LICENSE 文件');
  else add('ok', 'license', `${pkg.license}，LICENSE 文件存在`);
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

function checkIcon() {
  const icon = pkg.icon;
  if (!icon) {
    add('warn', 'icon', '未配置 icon，Marketplace 用默认占位图，点击率会明显下降');
    return;
  }
  const abs = path.join(ROOT, icon);
  if (!fs.existsSync(abs)) {
    add('blocker', 'icon', `${icon} 不存在`);
    return;
  }
  const dim = pngSize(abs);
  if (!dim) {
    add('blocker', 'icon', `${icon} 不是合法 PNG`);
    return;
  }
  if (dim.w !== dim.h || dim.w < 128) {
    add('blocker', 'icon', `需为正方形且 ≥128px，当前 ${dim.w}×${dim.h}`);
  } else if (dim.bytes > 1024 * 1024) {
    add('blocker', 'icon', `体积 ${(dim.bytes / 1024).toFixed(0)}KB 超过 1MB 限制`);
  } else {
    add('ok', 'icon', `${dim.w}×${dim.h}，${(dim.bytes / 1024).toFixed(0)}KB`);
  }
}

const ALLOWED_CATEGORIES = new Set([
  'Azure', 'Data Science', 'Debuggers', 'Education', 'Extension Packs', 'Formatters',
  'Keymaps', 'Language Packs', 'Linters', 'Machine Learning', 'Notebooks', 'Other',
  'Programming Languages', 'SCM Providers', 'Snippets', 'Testing', 'Themes', 'Visualization',
]);

function checkListing() {
  const cats = pkg.categories || [];
  const bad = cats.filter((c) => !ALLOWED_CATEGORIES.has(c));
  if (!cats.length) add('blocker', 'categories', '未设置分类，Marketplace 无法归类');
  else if (bad.length) add('blocker', 'categories', `非法分类：${bad.join('、')}`);
  else add('ok', 'categories', cats.join(' / '));

  const kw = pkg.keywords || [];
  if (kw.length < 5) add('warn', 'keywords', `只有 ${kw.length} 个关键词，建议 5–15 个覆盖搜索意图`);
  else add('ok', 'keywords', `${kw.length} 个`);

  if (!pkg.galleryBanner) add('warn', 'galleryBanner', '未设置横幅配色，Marketplace 顶部用默认灰色');
  else add('ok', 'galleryBanner', pkg.galleryBanner.color || '');
}

function checkReadme() {
  const file = path.join(ROOT, 'README.md');
  if (!fs.existsSync(file)) {
    add('blocker', 'README', '缺少 README.md');
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const required = [
    ['快速开始', '缺少安装/上手段落'],
    ['配置', '缺少配置说明'],
    ['密钥', '缺少密钥/隐私说明'],
    ['隐私', '缺少隐私说明（发布规则要求明示数据流向）'],
  ];
  const missing = required.filter(([k]) => !text.includes(k));
  if (missing.length) {
    add('warn', 'README', missing.map(([, m]) => m).join('；'));
  } else {
    add('ok', 'README', `${(text.length / 1024).toFixed(1)}KB，含上手/配置/隐私段落`);
  }

  const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const local = images.filter((src) => !/^https?:/.test(src));
  if (local.length && !pkg.repository) {
    add('warn', 'README 图片', `${local.length} 张本地图片在 Marketplace 上不会显示（需要 repository 才能转成绝对 URL）`);
  } else if (imageCountNote(local)) {
    add('ok', 'README 图片', imageCountNote(local));
  }
}

function imageCountNote(local) {
  if (!local.length) return '';
  const missing = local.filter((src) => !fs.existsSync(path.join(ROOT, decodeURI(src))));
  return missing.length ? `有 ${missing.length} 张图片路径不存在` : `${local.length} 张本地图片`;
}

function checkVscodeignore() {
  const file = path.join(ROOT, '.vscodeignore');
  if (!fs.existsSync(file)) {
    add('blocker', '.vscodeignore', '缺少 .vscodeignore，源码与 node_modules 会被打进 vsix');
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const must = ['src/**', 'test/**', 'node_modules/**'];
  const missing = must.filter((p) => !text.includes(p));
  if (missing.length) add('blocker', '.vscodeignore', `未排除：${missing.join('、')}`);
  else add('ok', '.vscodeignore', '已排除 src / test / node_modules');
}

function checkActivation() {
  const events = pkg.activationEvents || [];
  if (events.includes('*')) add('blocker', 'activationEvents', '不允许使用 * 通配激活');
  else if (events.includes('onStartupFinished')) add('warn', 'activationEvents', '含 onStartupFinished（每次启动都激活），确认状态栏计数确实需要');
  else add('ok', 'activationEvents', events.join(', ') || '仅按需激活');
}

function checkAssets() {
  const provDir = path.join(ROOT, 'media', 'providers');
  const svgs = fs.existsSync(provDir) ? fs.readdirSync(provDir).filter((f) => f.endsWith('.svg')) : [];
  if (svgs.length < 8) add('warn', '服务商图标', `media/providers 只有 ${svgs.length} 个图标，设置页会退回字母占位`);
  else add('ok', '服务商图标', `${svgs.length} 个`);

  for (const f of ['media/activity.svg', pkg.main]) {
    if (!f) continue;
    if (!fs.existsSync(path.join(ROOT, f))) add('blocker', '产物', `${f} 不存在（先 npm run build）`);
  }
}

function renderResults() {
  const blockers = results.filter((r) => r.level === 'blocker');
  const warns = results.filter((r) => r.level === 'warn');
  step('发布前检查（开发计划 §6.2）');
  for (const r of results) {
    if (r.level === 'ok') ok(`${r.label} — ${r.detail}`);
    else if (r.level === 'warn') warn(`${r.label} — ${r.detail}`);
    else fail(`${r.label} — ${r.detail}`);
  }
  if (blockers.length) {
    console.log(`\n${C.red}${C.bold}阻断项 ${blockers.length} 个${C.reset}，修好后再发。`);
    return false;
  }
  if (warns.length) console.log(`\n${C.yellow}通过，但有 ${warns.length} 个提醒项。${C.reset}`);
  else console.log(`\n${C.green}检查全部通过。${C.reset}`);
  return true;
}

/* ---------------------------------------------------------- 远端占用与令牌 */

function httpsJson(method, url, body) {
  return new Promise((resolve) => {
    let lib;
    try {
      lib = require(url.startsWith('https') ? 'https' : 'http');
    } catch {
      return resolve(null);
    }
    const req = lib.request(url, { method, timeout: 8000, headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, json: null });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function checkRemote() {
  step('远端状态');
  const payload = {
    filters: [{ criteria: [{ filterType: 7, value: `${pkg.publisher}.${pkg.name}` }], pageNumber: 1, pageSize: 1, sortBy: 0, sortOrder: 0 }],
    flags: 0x1 | 0x2 | 0x80,
  };
  const res = await httpsJson('POST', 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', payload);
  if (!res || !res.json) {
    warn('连不上 Marketplace 查询接口（离线或被墙），跳过占用检查');
    return;
  }
  const ext = res.json.results && res.json.results[0] && res.json.results[0].extensions && res.json.results[0].extensions[0];
  if (!ext) {
    info(`Marketplace 上还没有 ${pkg.publisher}.${pkg.name}，这将是首次发布`);
    return;
  }
  const versions = (ext.versions || []).map((v) => v.version);
  ok(`已存在：${ext.publisher.publisherName}/${ext.extensionName}，${versions.length} 个版本，最新 ${versions[0] || '—'}`);
  if (versions.includes(pkg.version)) {
    const detail = `Marketplace 上已有 ${pkg.version}，已发布版本不可覆盖，请先升版本号（npm version patch|minor）`;
    add('blocker', '版本占用', detail);
    fail(detail);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------ 构建与打包 */

function runVerify() {
  step('全量校验（图标 → 类型 → 单测 → 构建 → 冒烟 → 端到端）');
  run('npm', ['run', 'verify']);
  ok('verify 通过');
}

function buildProduction() {
  step('生产构建');
  run('node', ['esbuild.js', '--production']);
  const file = path.join(ROOT, 'dist', 'extension.js');
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  ok(`dist/extension.js ${kb} KB（--production，即实际入包体积）`);
}

function packageVsix() {
  step('打包 vsix');
  const out = `${pkg.name}-${pkg.version}${PRE_RELEASE ? '-pre' : ''}.vsix`;
  const args = ['package', '--no-dependencies', '--out', out];
  if (!pkg.repository) args.push('--allow-missing-repository');
  if (PRE_RELEASE) args.push('--pre-release');
  run(bin('vsce'), args);
  const abs = path.join(ROOT, out);
  const kb = (fs.statSync(abs).size / 1024).toFixed(1);
  ok(`${out}（${kb} KB）`);
  return abs;
}

function listVsix(vsix) {
  step('包内容抽查');
  const res = run(bin('vsce'), ['ls', '--no-dependencies'], { capture: true, allowFail: true });
  const lines = `${res.stdout || ''}${res.stderr || ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(INFO|WARN|ERROR|error|warning)/i.test(l) && !/^(npm info|>)/.test(l));
  if (!lines.length) {
    warn('未能列出包内容，直接看上面 vsce package 的清单');
    return;
  }
  info(`共 ${lines.length} 个文件入包：${lines.slice(0, 4).join('、')}${lines.length > 4 ? ' …' : ''}`);
  const suspicious = lines.filter((l) => /^(src|test|node_modules)\//.test(l) || /\.(ts|map)$/.test(l));
  if (suspicious.length) warn(`疑似不该入包：${suspicious.slice(0, 3).join('、')}`);
  else ok('未发现源码 / 测试 / 依赖 / sourcemap 泄漏');
}

/* ---------------------------------------------------------------- 发布动作 */

function publishMarketplace(vsix) {
  const pat = process.env.VSCE_PAT;
  if (!pat) {
    fail('缺少 VSCE_PAT，无法推送到 Visual Studio Marketplace');
    info('生成方式：https://dev.azure.com → User settings → Personal access tokens');
    info('Scope 选 Marketplace → Manage；发布者需先在 https://marketplace.visualstudio.com/manage 创建');
    return false;
  }
  step(`推送到 Marketplace${PRE_RELEASE ? '（预发布渠道）' : ''}`);
  const args = ['publish', '--packagePath', vsix, '--pat', pat];
  if (PRE_RELEASE) args.push('--pre-release');
  if (SKIP_DUPLICATE) args.push('--skip-duplicate');
  if (!pkg.repository) args.push('--allow-missing-repository');
  const res = run(bin('vsce'), args, { allowFail: true });
  if (res.status !== 0) {
    fail('Marketplace 推送失败，检查 PAT 是否过期、publisher 是否属于该账号');
    return false;
  }
  ok('已推送');
  info(`https://marketplace.visualstudio.com/items?itemName=${pkg.publisher}.${pkg.name}`);
  return true;
}

function publishOpenVsx(vsix) {
  const token = process.env.OVSX_PAT;
  if (!token) {
    warn('缺少 OVSX_PAT，跳过 Open VSX（VSCodium / 国产 IDE 走这个源）');
    info('令牌：https://open-vsx.org/user-settings/tokens；发布者命名空间需先创建');
    return false;
  }
  step('推送到 Open VSX');
  const args = ['publish', vsix, '-p', token];
  if (PRE_RELEASE) args.push('--pre-release');
  const res = run(bin('ovsx'), args, { allowFail: true });
  if (res.status !== 0) {
    fail('Open VSX 推送失败');
    return false;
  }
  ok('已推送');
  info(`https://open-vsx.org/extension/${pkg.publisher}/${pkg.name}`);
  return true;
}

/* ------------------------------------------------------------------- main */

(async () => {
  console.log(`${C.bold}CommitCraft 发布流水线${C.reset}  ${C.dim}v${pkg.version} · 模式 ${MODE}${PRE_RELEASE ? ' · 预发布' : ''}${C.reset}`);

  checkVersion();
  checkEngines();
  checkPublisher();
  checkRepo();
  checkLicense();
  checkIcon();
  checkListing();
  checkReadme();
  checkVscodeignore();
  checkActivation();
  checkAssets();

  const passed = renderResults();

  if (MODE === 'check') {
    process.exit(passed ? 0 : 1);
  }
  if (!passed) {
    console.log(`\n${C.dim}提示：先跑 npm run build 生成产物，再重新检查。${C.reset}`);
    process.exit(1);
  }

  const remoteOk = await checkRemote();
  if (remoteOk === false) process.exit(1);

  if (!SKIP_VERIFY) runVerify();
  else warn('已跳过 verify（--skip-verify）');

  buildProduction();
  const vsix = packageVsix();
  listVsix(vsix);

  if (MODE === 'dry-run' || TARGET === 'vsix') {
    step('完成');
    ok(`产物：${path.basename(vsix)}（--dry-run / --target vsix，未推送远端）`);
    process.exit(0);
  }

  let any = false;
  if (TARGET === 'all' || TARGET === 'marketplace') any = publishMarketplace(vsix) || any;
  if (TARGET === 'all' || TARGET === 'openvsx') any = publishOpenVsx(vsix) || any;

  step(any ? '发布完成' : '发布未完成');
  if (!any) {
    console.log(`  ${C.yellow}本地产物已就绪：${path.basename(vsix)}${C.reset}`);
    console.log(`  ${C.dim}设置环境变量后重跑：VSCE_PAT=xxx OVSX_PAT=yyy npm run release${C.reset}`);
    process.exit(2);
  }
  process.exit(0);
})().catch((err) => {
  console.error(`\n${C.red}流水线中断：${err.message}${C.reset}`);
  process.exit(1);
});
