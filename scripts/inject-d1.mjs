#!/usr/bin/env node
/**
 * CI 用：自动查询 ddns-rotation D1 数据库的 UUID 并写入 wrangler.toml
 * 依赖构建环境自带的 Cloudflare 凭据（Workers Builds 会注入）
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DB_NAME = 'ddns-rotation';
const PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';

let out;
try {
  out = execSync('npx wrangler d1 list --json', {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (err) {
  console.error('✘ 执行 wrangler d1 list 失败：', err.message);
  process.exit(1);
}

// 输出可能混有日志文本，提取最外层 JSON
const s = out.indexOf('[');
const e = out.lastIndexOf(']');
if (s === -1 || e === -1) {
  console.error('✘ 无法解析 wrangler d1 list 输出：\n' + out.slice(0, 500));
  process.exit(1);
}

let dbs;
try {
  dbs = JSON.parse(out.slice(s, e + 1));
} catch {
  console.error('✘ wrangler d1 list 输出不是合法 JSON：\n' + out.slice(0, 500));
  process.exit(1);
}

const db = Array.isArray(dbs) ? dbs.find((d) => d.name === DB_NAME) : null;
if (!db || !db.uuid) {
  console.error(`✘ 账号下未找到名为 ${DB_NAME} 的 D1 数据库。请先在 Cloudflare 控制台创建后再构建。`);
  process.exit(1);
}

const toml = readFileSync('wrangler.toml', 'utf8');
const m = toml.match(/database_id\s*=\s*"([^"]*)"/);
if (m && m[1] && m[1] !== PLACEHOLDER) {
  console.log(`✓ wrangler.toml 已有 database_id（${m[1]}），跳过注入`);
  process.exit(0);
}

writeFileSync('wrangler.toml', toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${db.uuid}"`));
console.log(`✓ 已注入 database_id = ${db.uuid}`);
