// 排班计算 + 解析同步（幂等：只有目标 IP 变化时才调用厂商 API）
import { zonedParts, minutesOf, dayIndex, parseDayIndex, inWindow, fqdn } from './lib/time.js';
import { applyRecord } from './providers/index.js';

export async function qAll(env, sql, ...args) {
  const r = await env.DB.prepare(sql).bind(...args).all();
  return r.results || [];
}

export async function qOne(env, sql, ...args) {
  const rows = await qAll(env, sql, ...args);
  return rows[0] || null;
}

export async function qRun(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run();
}

export async function writeLog(env, { level = 'info', group_id = null, machine_id = null, action = '', message = '' }) {
  await qRun(
    env,
    'INSERT INTO logs (level, group_id, machine_id, action, message) VALUES (?, ?, ?, ?, ?)',
    level,
    group_id,
    machine_id,
    action,
    String(message).slice(0, 500),
  );
}

export async function getState(env, key) {
  const row = await qOne(env, 'SELECT value FROM state WHERE key = ?', key);
  return row ? row.value : '';
}

export async function setState(env, key, value) {
  await qRun(
    env,
    "INSERT INTO state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    key,
    value,
  );
}

export function parseConfig(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}

/* ---------------- 排班计算 ---------------- */

export function groupMembers(env, groupId) {
  return qAll(
    env,
    `SELECT gm.*, m.id AS machine_id, m.name AS machine_name, m.ip AS machine_ip, m.enabled AS machine_enabled, m.note AS machine_note
     FROM group_machines gm
     JOIN machines m ON m.id = gm.machine_id
     WHERE gm.group_id = ? AND gm.enabled = 1 AND m.enabled = 1
     ORDER BY gm.sort_order, gm.id`,
    groupId,
  );
}

export function resolveTarget(group, members, now = new Date()) {
  const list = (members || []).filter((m) => Number(m.machine_enabled) !== 0);
  if (!list.length) return { machine: null, online: [], reason: '组内无启用机器' };

  if (group.mode === 'static') {
    return { machine: list[0], online: list, reason: '固定首台' };
  }

  const p = zonedParts(now, group.timezone || 'Asia/Shanghai');

  if (group.mode === 'rotate') {
    const switchMin = minutesOf(group.switch_time || '00:00');
    let d = dayIndex(p.year, p.month, p.day);
    if (p.minuteOfDay < switchMin) d -= 1; // 切换时刻前沿用前一天的值班机器
    const anchor = parseDayIndex(group.anchor_date);
    const idx = (((d - anchor) % list.length) + list.length) % list.length;
    return {
      machine: list[idx],
      online: [list[idx]],
      reason: `按天轮转 → 第 ${idx + 1}/${list.length} 台（每日 ${group.switch_time} 切换）`,
    };
  }

  // window：按在线时段命中
  const online = list.filter((m) => inWindow(p.minuteOfDay, m.window_start, m.window_end));
  if (online.length) {
    return { machine: online[0], online, reason: `时段命中 ${online[0].window_start}-${online[0].window_end}` };
  }
  return { machine: null, online: [], reason: '当前时段无机器在线' };
}

export function nextChange(group, members, now = new Date()) {
  const list = (members || []).filter((m) => Number(m.machine_enabled) !== 0);
  if (!list.length) return null;
  const p = zonedParts(now, group.timezone || 'Asia/Shanghai');

  if (group.mode === 'rotate') {
    const target = minutesOf(group.switch_time || '00:00');
    const delta = ((target - p.minuteOfDay + 1440) % 1440) || 1440;
    return { inMinutes: delta, at: new Date(now.getTime() + delta * 60000).toISOString(), kind: '轮转切换' };
  }
  if (group.mode === 'static') return null;

  const current = list.filter((m) => inWindow(p.minuteOfDay, m.window_start, m.window_end));
  if (current.length) {
    const delta = ((minutesOf(current[0].window_end) - p.minuteOfDay + 1440) % 1440) || 1440;
    return { inMinutes: delta, at: new Date(now.getTime() + delta * 60000).toISOString(), kind: '当前机器下线' };
  }
  let best = 1440;
  for (const m of list) {
    const delta = ((minutesOf(m.window_start) - p.minuteOfDay + 1440) % 1440) || 1440;
    if (delta < best) best = delta;
  }
  return { inMinutes: best, at: new Date(now.getTime() + best * 60000).toISOString(), kind: '下一台机器上线' };
}

/* ---------------- 同步执行 ---------------- */

export async function syncGroup(env, group, { force = false } = {}) {
  const members = await groupMembers(env, group.id);
  const { machine, reason } = resolveTarget(group, members, new Date());
  const ip = (machine?.machine_ip || group.fallback_ip || '').trim();
  const summary = { groupId: group.id, group: group.name, machine: machine?.machine_name || null, ip, reason, results: [] };

  if (!ip) {
    await writeLog(env, { level: 'warn', group_id: group.id, action: 'sync.skip', message: `${group.name}：${reason} 且未配置兜底 IP，跳过` });
    summary.results.push({ domain: '-', ok: false, message: '无可用 IP' });
    return summary;
  }
  if (!machine) {
    await writeLog(env, { level: 'info', group_id: group.id, action: 'sync.fallback', message: `${group.name}：${reason}，使用兜底 IP ${ip}` });
  }

  const domains = await qAll(
    env,
    `SELECT d.*, c.config AS cred_config, c.name AS cred_name
     FROM group_domains d
     LEFT JOIN credentials c ON c.id = d.credential_id
     WHERE d.group_id = ? AND d.enabled = 1`,
    group.id,
  );

  for (const d of domains) {
    const key = `rec:${d.id}`;
    const last = await getState(env, key);
    const name = fqdn(d.domain, d.record_name);

    if (last === ip && !force) {
      summary.results.push({ domain: name, ip, ok: true, changed: false, message: '已是最新，跳过' });
      continue;
    }

    try {
      const cfg = parseConfig(d.cred_config);
      const res = await applyRecord(d.provider, cfg, d, ip);
      await setState(env, key, ip);

      // 自动回填 zone_id / record_id，避免每次查询
      if ((res.recordId && res.recordId !== d.record_id) || (res.zoneId && res.zoneId !== d.zone_id)) {
        await qRun(env, 'UPDATE group_domains SET record_id = ?, zone_id = ? WHERE id = ?', res.recordId || d.record_id, res.zoneId || d.zone_id, d.id);
      }

      await writeLog(env, {
        level: 'info',
        group_id: group.id,
        machine_id: machine?.machine_id || null,
        action: 'dns.update',
        message: `${name} → ${ip}（${machine?.machine_name || '兜底IP'}｜${d.provider}）`,
      });
      summary.results.push({ domain: name, ip, ok: true, changed: true, message: res.dryRun ? '演练模式，未实际下发' : '已更新' });
    } catch (err) {
      await writeLog(env, {
        level: 'error',
        group_id: group.id,
        machine_id: machine?.machine_id || null,
        action: 'dns.error',
        message: `${name} → ${ip} 失败：${err.message || err}`,
      });
      summary.results.push({ domain: name, ip, ok: false, changed: false, message: err.message || String(err) });
    }
  }

  return summary;
}

export async function syncAll(env, { force = false, groupId = null } = {}) {
  const groups = groupId
    ? await qAll(env, 'SELECT * FROM groups WHERE id = ?', groupId)
    : await qAll(env, 'SELECT * FROM groups WHERE enabled = 1 ORDER BY id');

  const out = [];
  for (const g of groups) {
    try {
      out.push(await syncGroup(env, g, { force }));
    } catch (err) {
      await writeLog(env, { level: 'error', group_id: g.id, action: 'sync.error', message: `${g.name}：${err.message || err}` });
      out.push({ groupId: g.id, group: g.name, error: err.message || String(err), results: [] });
    }
  }
  return out;
}
