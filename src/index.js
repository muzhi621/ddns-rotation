import { Hono } from 'hono';
import {
  qAll,
  qRun,
  qOne,
  getState,
  groupMembers,
  resolveTarget,
  nextChange,
  syncAll,
  syncGroup,
  parseConfig,
  writeLog,
} from './scheduler.js';
import { PROVIDER_LABELS, providerFields, providerDocs, resolveRecord } from './providers/index.js';

const app = new Hono();

app.onError((err, c) => c.json({ error: err.message || String(err) }, 500));

const int = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const bool = (v, def = 1) => (v === undefined || v === null ? def : v ? 1 : 0);
const IP4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const validIp = (ip) => !ip || (IP4.test(ip) && ip.split('.').every((n) => +n <= 255));
const validHM = (s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

// 无敏感信息，放在鉴权之前：保证未登录时管理后台也能渲染厂商/模式选项
app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/meta', (c) =>
  c.json({
    providers: Object.entries(PROVIDER_LABELS).map(([key, label]) => ({ key, label, fields: providerFields(key), docs: providerDocs(key) })),
    modes: [
      { key: 'window', label: '按在线时段', desc: '为每台机器填写在线时段（与云厂商开机时间一致），自动解析给时段内的机器，支持跨天' },
      { key: 'rotate', label: '按天轮转', desc: '组内机器每天轮流值班，每日固定时刻切换' },
      { key: 'static', label: '固定首台', desc: '始终解析给组内第一台机器，不做轮换' },
    ],
    timezones: ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'UTC', 'America/Los_Angeles', 'Europe/London'],
  }),
);

// 简单鉴权：设置 ADMIN_TOKEN 后，其余 /api/* 需 Bearer 令牌
app.use('/api/*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return next();
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (auth !== token) return c.json({ error: '未授权：请在右上角填入正确的 ADMIN_TOKEN' }, 401);
  await next();
});

app.get('/api/overview', async (c) => {
  const now = new Date();
  const machines = await qAll(c.env, 'SELECT * FROM machines ORDER BY id');
  const credentials = await qAll(c.env, 'SELECT id, name, provider, created_at FROM credentials ORDER BY id');
  const groups = await qAll(c.env, 'SELECT * FROM groups ORDER BY id');
  const result = [];

  for (const g of groups) {
    const members = await groupMembers(c.env, g.id);
    const { machine, online, reason } = resolveTarget(g, members, now);
    const records = await qAll(
      c.env,
      `SELECT d.*, c.name AS cred_name FROM group_domains d
       LEFT JOIN credentials c ON c.id = d.credential_id
       WHERE d.group_id = ? ORDER BY d.id`,
      g.id,
    );
    const withState = [];
    for (const r of records) withState.push({ ...r, current: await getState(c.env, `rec:${r.id}`) });

    result.push({
      ...g,
      members: members.map((m) => ({
        id: m.id,
        machine_id: m.machine_id,
        name: m.machine_name,
        ip: m.machine_ip,
        window_start: m.window_start,
        window_end: m.window_end,
        sort_order: m.sort_order,
        enabled: m.enabled,
      })),
      online: online.map((m) => m.machine_name),
      target: { name: machine?.machine_name || null, ip: machine?.machine_ip || g.fallback_ip || '', reason },
      next: nextChange(g, members, now),
      records: withState,
    });
  }

  const logs = await qAll(c.env, 'SELECT * FROM logs ORDER BY id DESC LIMIT 50');
  return c.json({ now: now.toISOString(), machines, credentials, groups: result, logs });
});

app.get('/api/logs', async (c) => {
  const limit = Math.min(int(c.req.query('limit'), 100), 500);
  return c.json({ logs: await qAll(c.env, 'SELECT * FROM logs ORDER BY id DESC LIMIT ?', limit) });
});

/* ---------------- 机器 ---------------- */

app.get('/api/machines', async (c) => c.json({ machines: await qAll(c.env, 'SELECT * FROM machines ORDER BY id') }));

app.post('/api/machines', async (c) => {
  const b = await c.req.json();
  if (!b.name) return c.json({ error: '名称必填' }, 400);
  if (!validIp(String(b.ip || '').trim())) return c.json({ error: '公网 IP 格式不正确（应为 IPv4，如 1.2.3.4）' }, 400);
  const r = await qRun(
    c.env,
    'INSERT INTO machines (name, ip, note, enabled) VALUES (?, ?, ?, ?)',
    String(b.name).slice(0, 64),
    String(b.ip || '').trim(),
    String(b.note || '').slice(0, 200),
    bool(b.enabled, 1),
  );
  return c.json({ ok: true, id: r.meta?.last_row_id });
});

app.put('/api/machines/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  if (b.ip !== undefined && !validIp(String(b.ip).trim())) return c.json({ error: '公网 IP 格式不正确（应为 IPv4，如 1.2.3.4）' }, 400);
  await qRun(
    c.env,
    'UPDATE machines SET name = COALESCE(?, name), ip = COALESCE(?, ip), note = COALESCE(?, note), enabled = COALESCE(?, enabled) WHERE id = ?',
    b.name === undefined ? null : String(b.name).slice(0, 64),
    b.ip === undefined ? null : String(b.ip).trim(),
    b.note === undefined ? null : String(b.note).slice(0, 200),
    b.enabled === undefined ? null : bool(b.enabled, 1),
    id,
  );
  return c.json({ ok: true });
});

app.delete('/api/machines/:id', async (c) => {
  const id = c.req.param('id');
  await qRun(c.env, 'DELETE FROM group_machines WHERE machine_id = ?', id);
  await qRun(c.env, 'DELETE FROM machines WHERE id = ?', id);
  return c.json({ ok: true });
});

/* ---------------- 分组 ---------------- */

app.get('/api/groups', async (c) => c.json({ groups: await qAll(c.env, 'SELECT * FROM groups ORDER BY id') }));

app.post('/api/groups', async (c) => {
  const b = await c.req.json();
  if (!b.name) return c.json({ error: '分组名称必填' }, 400);
  const r = await qRun(
    c.env,
    'INSERT INTO groups (name, mode, timezone, switch_time, anchor_date, fallback_ip, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
    String(b.name).slice(0, 64),
    ['window', 'rotate', 'static'].includes(b.mode) ? b.mode : 'window',
    String(b.timezone || 'Asia/Shanghai'),
    String(b.switch_time || '03:00'),
    String(b.anchor_date || '1970-01-01'),
    String(b.fallback_ip || '').trim(),
    bool(b.enabled, 1),
  );
  return c.json({ ok: true, id: r.meta?.last_row_id });
});

app.put('/api/groups/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const sets = [];
  const vals = [];
  const map = {
    name: (v) => String(v).slice(0, 64),
    mode: (v) => (['window', 'rotate', 'static'].includes(v) ? v : 'window'),
    timezone: (v) => String(v),
    switch_time: (v) => String(v),
    anchor_date: (v) => String(v),
    fallback_ip: (v) => String(v || '').trim(),
    enabled: (v) => bool(v, 1),
  };
  for (const [k, fn] of Object.entries(map)) {
    if (b[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fn(b[k]));
    }
  }
  if (!sets.length) return c.json({ ok: true });
  vals.push(id);
  await qRun(c.env, `UPDATE groups SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  return c.json({ ok: true });
});

app.delete('/api/groups/:id', async (c) => {
  const id = c.req.param('id');
  const recs = await qAll(c.env, 'SELECT id FROM group_domains WHERE group_id = ?', id);
  for (const r of recs) await qRun(c.env, 'DELETE FROM state WHERE key = ?', `rec:${r.id}`);
  await qRun(c.env, 'DELETE FROM group_domains WHERE group_id = ?', id);
  await qRun(c.env, 'DELETE FROM group_machines WHERE group_id = ?', id);
  await qRun(c.env, 'DELETE FROM groups WHERE id = ?', id);
  return c.json({ ok: true });
});

// 全量保存组内机器与排班
app.put('/api/groups/:id/members', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const items = Array.isArray(b.items) ? b.items : [];
  for (const it of items) {
    it.window_start = String(it.window_start || '00:00');
    it.window_end = String(it.window_end || '23:59');
    if (!validHM(it.window_start) || !validHM(it.window_end)) {
      return c.json({ error: '在线时段格式应为 HH:MM（如 08:00）' }, 400);
    }
  }
  await qRun(c.env, 'DELETE FROM group_machines WHERE group_id = ?', id);
  const seen = new Set();
  let order = 0;
  for (const it of items) {
    const mid = int(it.machine_id, 0);
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    await qRun(
      c.env,
      'INSERT OR REPLACE INTO group_machines (group_id, machine_id, window_start, window_end, sort_order, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      mid,
      String(it.window_start || '00:00'),
      String(it.window_end || '23:59'),
      order++,
      bool(it.enabled, 1),
    );
  }
  return c.json({ ok: true });
});

/* ---------------- 解析记录 ---------------- */

app.get('/api/domains', async (c) => {
  const gid = c.req.query('group_id');
  const sql = `SELECT d.*, c.name AS cred_name FROM group_domains d
               LEFT JOIN credentials c ON c.id = d.credential_id
               ${gid ? 'WHERE d.group_id = ?' : ''} ORDER BY d.id`;
  const rows = gid ? await qAll(c.env, sql, gid) : await qAll(c.env, sql);
  const out = [];
  for (const r of rows) out.push({ ...r, current: await getState(c.env, `rec:${r.id}`) });
  return c.json({ domains: out });
});

app.post('/api/domains', async (c) => {
  const b = await c.req.json();
  if (!b.group_id || !b.domain) return c.json({ error: '分组与域名必填' }, 400);
  const domain = String(b.domain).trim().toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
    return c.json({ error: '域名格式不正确（如 example.com）' }, 400);
  }
  const r = await qRun(
    c.env,
    `INSERT INTO group_domains (group_id, credential_id, provider, domain, record_name, record_type, ttl, proxied, zone_id, record_id, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    int(b.group_id),
    int(b.credential_id, 0),
    String(b.provider || 'cloudflare'),
    domain,
    String(b.record_name || '@'),
    String(b.record_type || 'A').toUpperCase(),
    int(b.ttl, 600),
    bool(b.proxied, 0),
    String(b.zone_id || ''),
    String(b.record_id || ''),
    bool(b.enabled, 1),
  );
  return c.json({ ok: true, id: r.meta?.last_row_id });
});

app.put('/api/domains/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const map = {
    group_id: (v) => int(v),
    credential_id: (v) => int(v, 0),
    provider: (v) => String(v),
    domain: (v) => String(v).trim().toLowerCase(),
    record_name: (v) => String(v || '@'),
    record_type: (v) => String(v || 'A').toUpperCase(),
    ttl: (v) => int(v, 600),
    proxied: (v) => bool(v, 0),
    zone_id: (v) => String(v || ''),
    record_id: (v) => String(v || ''),
    enabled: (v) => bool(v, 1),
  };
  const sets = [];
  const vals = [];
  for (const [k, fn] of Object.entries(map)) {
    if (b[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fn(b[k]));
    }
  }
  if (!sets.length) return c.json({ ok: true });
  vals.push(id);
  await qRun(c.env, `UPDATE group_domains SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  return c.json({ ok: true });
});

app.delete('/api/domains/:id', async (c) => {
  const id = c.req.param('id');
  await qRun(c.env, 'DELETE FROM state WHERE key = ?', `rec:${id}`);
  await qRun(c.env, 'DELETE FROM group_domains WHERE id = ?', id);
  return c.json({ ok: true });
});

/* ---------------- 凭据 ---------------- */

app.get('/api/credentials', async (c) => c.json({ credentials: await qAll(c.env, 'SELECT * FROM credentials ORDER BY id') }));

app.post('/api/credentials', async (c) => {
  const b = await c.req.json();
  if (!b.name || !b.provider) return c.json({ error: '名称与厂商必填' }, 400);
  const r = await qRun(
    c.env,
    'INSERT INTO credentials (name, provider, config) VALUES (?, ?, ?)',
    String(b.name).slice(0, 64),
    String(b.provider),
    JSON.stringify(b.config || {}),
  );
  return c.json({ ok: true, id: r.meta?.last_row_id });
});

app.put('/api/credentials/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const cur = await qOne(c.env, 'SELECT * FROM credentials WHERE id = ?', id);
  if (!cur) return c.json({ error: 'not found' }, 404);
  await qRun(
    c.env,
    'UPDATE credentials SET name = ?, provider = ?, config = ? WHERE id = ?',
    b.name === undefined ? cur.name : String(b.name).slice(0, 64),
    b.provider === undefined ? cur.provider : String(b.provider),
    b.config === undefined ? cur.config : JSON.stringify(b.config),
    id,
  );
  return c.json({ ok: true });
});

app.delete('/api/credentials/:id', async (c) => {
  const id = c.req.param('id');
  const used = await qAll(c.env, 'SELECT id, domain FROM group_domains WHERE credential_id = ?', id);
  if (used.length) {
    return c.json({ error: `该凭据正被 ${used.length} 条解析记录使用（如 ${used[0].domain}），请先编辑或删除这些记录` }, 400);
  }
  await qRun(c.env, 'DELETE FROM credentials WHERE id = ?', id);
  return c.json({ ok: true });
});

// 凭据连通性测试：查询目标记录当前值
app.post('/api/credentials/:id/test', async (c) => {
  const cred = await qOne(c.env, 'SELECT * FROM credentials WHERE id = ?', c.req.param('id'));
  if (!cred) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const rec = {
    domain: String(b.domain || '').trim().toLowerCase(),
    record_name: b.record_name || '@',
    record_type: (b.record_type || 'A').toUpperCase(),
    ttl: int(b.ttl, 600),
    proxied: bool(b.proxied, 0),
    zone_id: b.zone_id || '',
    record_id: b.record_id || '',
  };
  if (!rec.domain) return c.json({ error: '缺少 domain' }, 400);
  const res = await resolveRecord(cred.provider, parseConfig(cred.config), rec);
  return c.json({ ok: true, ...res });
});

/* ---------------- 手动同步 / 预览 ---------------- */

app.post('/api/sync', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const force = !!b.force;
  const gid = b.group_id ? int(b.group_id) : null;
  const out = await syncAll(c.env, { force, groupId: gid });
  return c.json({ ok: true, results: out });
});

app.get('/api/preview', async (c) => {
  const gid = int(c.req.query('group_id'), 0);
  const at = c.req.query('at') ? new Date(c.req.query('at')) : new Date();
  const groups = gid ? await qAll(c.env, 'SELECT * FROM groups WHERE id = ?', gid) : await qAll(c.env, 'SELECT * FROM groups WHERE enabled = 1');
  const out = [];
  for (const g of groups) {
    const members = await groupMembers(c.env, g.id);
    const tz = g.timezone || 'Asia/Shanghai';
    const plan = [];
    for (let i = 0; i < 7; i++) {
      const t = new Date(at.getTime() + i * 86400000);
      const r = resolveTarget(g, members, t);
      plan.push({
        date: t.toISOString().slice(0, 10),
        machine: r.machine?.machine_name || null,
        ip: r.machine?.machine_ip || g.fallback_ip || '',
        reason: r.reason,
      });
    }
    out.push({ groupId: g.id, group: g.name, mode: g.mode, timezone: tz, plan });
  }
  return c.json({ preview: out });
});

app.post('/api/logs/clear', async (c) => {
  await qRun(c.env, 'DELETE FROM logs');
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncAll(env).then(async (r) => {
        await writeLog(env, { level: 'info', action: 'cron', message: `定时同步完成，分组 ${r.length} 个` });
      }),
    );
  },
};
