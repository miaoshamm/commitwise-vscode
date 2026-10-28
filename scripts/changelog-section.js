#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 取出某个版本的段落，用作 GitHub Release 正文。
 *
 * 用法：
 *   node scripts/changelog-section.js 0.5.0
 *
 * 规则：命中 `## 0.5.0` 或 `## [0.5.0]` 标题（精确匹配版本号，避免 0.5 命中 0.5.0），
 * 取到下一个 `## ` 标题之前。找不到时退出码 1，方便在 CI 里当发布前的硬门槛。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || '').trim();
if (!version) {
  console.error('用法：node scripts/changelog-section.js <version>');
  process.exit(2);
}

const file = path.join(__dirname, '..', 'CHANGELOG.md');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const isHeading = (line) => /^##\s/.test(line);
const normalize = (line) => line.slice(2).trim().replace(/^\[/, '').replace(/\]$/, '');

let start = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (isHeading(lines[i]) && normalize(lines[i]) === version) {
    start = i;
    break;
  }
}

if (start < 0) {
  console.error(`CHANGELOG.md 里找不到 "## ${version}" 段落，请先补这一节再发版`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (isHeading(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md 的 "## ${version}" 段落是空的`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
