// name.com API v4（Basic Auth）
// 支持 zone 自动探测：domain 填完整子域（如 ddns1.example.com）时自动拆出父域名作 zone
import { normalizeRecordName } from '../lib/time.js';

const EP = 'https://api.name.com/v4';

export const fields = [
  { key: 'username', label: '用户名' },
  { key: 'api_token', label: 'API Token', secret: true, hint: 'name.com → 账户设置 → API' },
];

function authHeader(cfg) {
  return `Basic ${btoa(`${cfg.username}:${cfg.api_token}`)}`;
}

async function call(cfg, path, init = {}) {
  const res = await fetch(`${EP}${path}`, {
    ...init,
    headers: { Authorization: authHeader(cfg), 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`name.com: ${json.message || `HTTP ${res.status}`}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// zone 自动探测：先用完整 domain 当 zone；404 则把最左一段拆成主机名，剩余部分当 zone
async function findZone(cfg, domain) {
  try {
    await call(cfg, `/domains/${encodeURIComponent(domain)}`);
    return { zone: domain, prefix: '' };
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const parts = domain.split('.');
  if (parts.length > 2) {
    const prefix = parts[0];
    const parent = parts.slice(1).join('.');
    try {
      await call(cfg, `/domains/${encodeURIComponent(parent)}`);
      return { zone: parent, prefix };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  throw new Error(`name.com: 账号下找不到 ${domain} 及其父域名，请确认域名已托管在该 name.com 账号`);
}

async function listRecords(cfg, zone) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const q = cursor ? `?perPage=100&recordId=${encodeURIComponent(cursor)}` : '?perPage=100';
    const json = await call(cfg, `/domains/${encodeURIComponent(zone)}/records${q}`);
    out.push(...(json.records || []));
    cursor = json.nextPage || '';
    if (!cursor) break;
  }
  return out;
}

// 计算 name.com 的 hostName：根域为空串，子域为相对前缀
function hostNameOf(prefix, rec) {
  const rn = normalizeRecordName(rec.record_name);
  const sub = rn === '@' ? '' : rn;
  return prefix ? (sub ? `${prefix}.${sub}` : prefix) : sub;
}

function matchRecord(records, hostName, type) {
  const t = (type || 'A').toUpperCase();
  return records.find(
    (r) => (r.type || '').toUpperCase() === t && String(r.hostName ?? r.host ?? '').toLowerCase() === hostName.toLowerCase(),
  );
}

export async function resolve({ cfg, rec }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const records = await listRecords(cfg, zone);
  const hit = matchRecord(records, hostNameOf(prefix, rec), rec.record_type || 'A');
  return { zoneId: zone, recordId: hit?.id ? String(hit.id) : '', content: hit?.answer || '' };
}

export async function update({ cfg, rec, value }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const records = await listRecords(cfg, zone);
  const hostName = hostNameOf(prefix, rec);
  const type = rec.record_type || 'A';
  const ttl = Math.max(60, Number(rec.ttl) || 300);
  const hit = matchRecord(records, hostName, type);
  const body = JSON.stringify({ host: hostName, type, answer: value, ttl });

  if (hit?.id) {
    await call(cfg, `/domains/${encodeURIComponent(zone)}/records/${hit.id}`, { method: 'PUT', body });
    return { zoneId: zone, recordId: String(hit.id), content: value };
  }
  // 记录不存在则创建，不强制要求预先手工建好
  const created = await call(cfg, `/domains/${encodeURIComponent(zone)}/records`, { method: 'POST', body });
  return { zoneId: zone, recordId: created.record?.id ? String(created.record.id) : '', content: value };
}
