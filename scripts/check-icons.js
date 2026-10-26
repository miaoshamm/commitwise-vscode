/**
 * 校验所有图标名真实存在。
 *
 * 背景：`new ThemeIcon('cpu')` 或 `"icon": "$(cpu)"` 里写错名字时，VSCode **不会报错**，
 * 只是把图标位置渲染成空白 —— 这类问题单元测试、冒烟测试、打包全都发现不了。
 * 所以这里拿一份 codicon 名单（scripts/codicon-names.json，来自 @vscode/codicons 的
 * codicon.css，共 746 个）对着源码和 package.json 逐个核对。
 *
 * 顺带检查两件容易被忽略的事：
 * 1. commands 的 icon 必须以 `$(` 开头，否则 VSCode 会当成图片路径去找文件；
 * 2. 挂在菜单 `inline` 组里的命令必须有图标，否则树节点右侧会渲染成一个长文字按钮。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const known = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'codicon-names.json'), 'utf8')));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const problems = [];
const checked = new Set();

/** `$(sync~spin)` 这类带动画修饰的，剥掉 `~spin` 再校验 */
function checkCodicon(name, where) {
  const bare = name.split('~')[0];
  checked.add(bare);
  if (!known.has(bare)) {
    problems.push(`${where}：图标 "${name}" 不存在${bare !== name ? `（去修饰后为 "${bare}"）` : ''}`);
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ---- 1. package.json 中命令的图标 ----
const commands = new Map();
for (const cmd of pkg.contributes?.commands ?? []) {
  commands.set(cmd.command, cmd);
  if (!cmd.icon) continue;
  if (!cmd.icon.startsWith('$(')) {
    problems.push(`package.json → ${cmd.command}.icon："${cmd.icon}" 不是 $(icon-name) 形式，会被当成图片路径`);
    continue;
  }
  const m = /^\$\(([^)]+)\)$/.exec(cmd.icon);
  if (!m) {
    problems.push(`package.json → ${cmd.command}.icon："${cmd.icon}" 格式不合法`);
    continue;
  }
  checkCodicon(m[1], `package.json → ${cmd.command}`);
}

// ---- 2. inline 菜单项必须有图标 ----
for (const [menuId, items] of Object.entries(pkg.contributes?.menus ?? {})) {
  for (const item of items) {
    if (item.group !== 'inline') continue;
    const cmd = commands.get(item.command);
    if (!cmd) continue;
    if (!cmd.icon) {
      problems.push(`menus.${menuId} → ${item.command} 挂在 inline 组但没有图标，节点右侧会显示长文字按钮`);
    }
  }
}

// ---- 3. 源码里的 $(name) 与 new ThemeIcon('name') ----
const dollarRe = /\$\(([a-z0-9-]+(?:~[a-z]+)?)\)/g;
const themeIconRe = /new\s+(?:vscode\.)?ThemeIcon\(\s*'([^']+)'/g;

for (const file of walk(path.join(root, 'src'))) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    for (const m of line.matchAll(dollarRe)) {
      checkCodicon(m[1], `${rel}:${i + 1}`);
    }
    for (const m of line.matchAll(themeIconRe)) {
      checkCodicon(m[1], `${rel}:${i + 1}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`图标校验失败，发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`图标校验通过：${checked.size} 个图标名全部存在（共引用 ${commands.size} 个命令）`);
