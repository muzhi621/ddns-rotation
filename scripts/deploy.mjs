#!/usr/bin/env node
/**
 * 一键部署助手：把「创建 D1 → 填 database_id → 建表 → 设 ADMIN_TOKEN → 部署」串成一条命令
 * 用法：node scripts/deploy.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const WRANGLER = './node_modules/.bin/wrangler';
const PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const step = (n, msg) => console.log(`\n${c.b(`[${n}/6]`)} ${msg}`);

/** 交互式执行（继承 stdio，用户可输入） */
function run(args) {
  const bin = process.platform === 'win32' && !existsSync(WRANGLER)
    ? 'npx'
    : (existsSync(WRANGLER) ? WRANGLER : 'npx');
  const finalArgs = bin === 'npx' ? ['wrangler', ...args] : args;
  return spawnSync(bin, finalArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
}

/** 捕获输出执行 */
function capture(args) {
  const bin = existsSync(WRANGLER) ? WRANGLER : 'npx';
  const finalArgs = bin === 'npx' ? ['wrangler', ...args] : args;
  const r = spawnSync(bin, finalArgs, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

/** 从可能被日志污染的输出里抠出 JSON */
function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    // 可能是 JSON Lines，逐行试
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('{')) {
        try { return JSON.parse(t); } catch { /* continue */ }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------- 1. 依赖
step(1, '检查依赖');
if (!existsSync('node_modules/wrangler')) {
  console.log(c.dim('首次运行，安装依赖…'));
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(c.r('npm install 失败，请检查网络后重试'));
    process.exit(1);
  }
}
console.log(c.g('✓ 依赖就绪'));

// ---------------------------------------------------------------- 2. 登录
step(2, '检查 Cloudflare 登录状态');
const who = capture(['whoami']);
if (!who.ok) {
  console.log(c.y('尚未登录，正在打开浏览器授权…'));
  const r = run(['login']);
  if (r.status !== 0) {
    console.error(c.r('登录失败。若本机无浏览器，请改用 API Token：'));
    console.error(c.dim('  CF 控制台 → My Profile → API Tokens → 使用 "Edit Cloudflare Workers" 模板创建'));
    console.error(c.dim('  然后设置环境变量后重试：export CLOUDFLARE_API_TOKEN=xxxx'));
    process.exit(1);
  }
} else {
  console.log(c.g('✓ 已登录'));
}

// ---------------------------------------------------------------- 3. D1
step(3, '准备 D1 数据库');
let toml = readFileSync('wrangler.toml', 'utf8');
let dbId = null;
const m = toml.match(/database_id\s*=\s*"([^"]+)"/);
if (m && m[1] !== PLACEHOLDER) {
  dbId = m[1];
  console.log(c.g(`✓ wrangler.toml 已有 database_id: ${dbId}`));
} else {
  console.log(c.dim('查找已存在的 ddns-rotation 数据库…'));
  const list = capture(['d1', 'list', '--json']);
  const parsed = list.ok ? extractJson(list.out) : null;
  const found = Array.isArray(parsed)
    ? parsed.find((d) => d.name === 'ddns-rotation')
    : null;

  if (found) {
    dbId = found.uuid;
    console.log(c.g(`✓ 复用已有数据库 ${dbId}`));
  } else {
    console.log(c.dim('创建数据库 ddns-rotation…'));
    const cre = capture(['d1', 'create', 'ddns-rotation', '--json']);
    const cp = cre.ok ? extractJson(cre.out) : null;
    dbId = cp?.uuid || cp?.id || null;
    if (!dbId) {
      // 兜底：从纯文本输出里抠 UUID
      const uuid = cre.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      dbId = uuid ? uuid[0] : null;
    }
    if (!dbId) {
      console.error(c.r('无法自动获取 database_id，请手动执行：npx wrangler d1 create ddns-rotation'));
      console.error(c.dim('把返回的 database_id 填进 wrangler.toml 后重新运行本脚本'));
      process.exit(1);
    }
    console.log(c.g(`✓ 已创建 ${dbId}`));
  }

  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`);
  writeFileSync('wrangler.toml', toml);
  console.log(c.g('✓ 已写入 wrangler.toml'));
}

// ---------------------------------------------------------------- 4. 建表
step(4, '初始化数据表（幂等，重复执行不会丢数据）');
const mig = run(['d1', 'execute', 'ddns-rotation', '--remote', '--file=./schema.sql']);
if (mig.status !== 0) {
  console.error(c.r('建表失败'));
  process.exit(1);
}
console.log(c.g('✓ 表结构就绪'));

// ---------------------------------------------------------------- 5. 密钥
step(5, '设置管理后台密码 ADMIN_TOKEN');
console.log(c.y('接下来会提示你输入一个密码（输入时不显示字符，回车确认）。'));
console.log(c.dim('这是管理后台的唯一鉴权，请务必设置一个强密码。'));
const sec = run(['secret', 'put', 'ADMIN_TOKEN']);
if (sec.status !== 0) {
  console.log(c.y('⚠ 跳过 ADMIN_TOKEN —— 后台将不鉴权，任何人都能改你的解析！'));
  console.log(c.dim('稍后手动补：npx wrangler secret put ADMIN_TOKEN'));
}

// ---------------------------------------------------------------- 6. 部署
step(6, '部署 Worker');
const dep = run(['deploy']);
if (dep.status !== 0) {
  console.error(c.r('部署失败，请阅读上方报错'));
  process.exit(1);
}

console.log(`\n${c.g(c.b('🎉 部署完成'))}`);
console.log(c.dim('常用命令：'));
console.log(c.dim('  npx wrangler tail              # 实时看日志'));
console.log(c.dim('  npx wrangler d1 execute ddns-rotation --remote --command "SELECT * FROM machines"'));
console.log(c.dim('  本地开发：npm run dev （先在 .dev.vars 写 ADMIN_TOKEN=dev）'));
