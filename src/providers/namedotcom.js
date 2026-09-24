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
    // 兼容字符串与对象，避免双重序列化（曾导致 Invalid Argument）
    body: init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`name.com: HTTP ${res.status} ${json.message || ''}`.trim());
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
  // nextPage 可能是相对路径（如 /v4/domains/x/records?perPage=100&recordId=abc）也可能是游标值
  let next = `/domains/${encodeURIComponent(zone)}/records?perPage=100`;
  for (let i = 0; i < 20; i++) {
    const json = await call(cfg, next);
    out.push(...(json.records || []));
    if (!json.nextPage) break;
    next = String(json.nextPage).startsWith('/') ? json.nextPage : `/domains/${encodeURIComponent(zone)}/records?recordId=${encodeURIComponent(json.nextPage)}`;
  }
  return out;
}

// 计算 name.com 的 hostName：根域为空串，子域为相对前缀
function hostNameOf(prefix, rec) {
  const rn = normalizeRecordName(rec.record_name);
  const sub = rn === '@' ? '' : rn;
  return prefix ? (sub ? `${prefix}.${sub}` : prefix) : sub;
}

function matchRecord(records, hostName, type, zone) {
  const t = (type || 'A').toUpperCase();
  const fqdnWant = hostName ? `${hostName}.${zone}`.toLowerCase() : String(zone || '').toLowerCase();
  return records.find((r) => {
    if ((r.type || '').toUpperCase() !== t) return false;
    const hn = String(r.hostName ?? r.host ?? '').toLowerCase();
    const f = String(r.fqdn ?? '').toLowerCase().replace(/\.$/, '');
    return hn === hostName.toLowerCase() || (f && f === fqdnWant);
  });
}

export async function resolve({ cfg, rec }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const records = await listRecords(cfg, zone);
  const hit = matchRecord(records, hostNameOf(prefix, rec), rec.record_type || 'A', zone);
  return { zoneId: zone, recordId: hit?.id ? String(hit.id) : '', content: hit?.answer || '' };
}

export async function update({ cfg, rec, value }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const records = await listRecords(cfg, zone);
  const hostName = hostNameOf(prefix, rec);
  const type = rec.record_type || 'A';
  const ttl = Math.max(60, Number(rec.ttl) || 300);
  const hit = matchRecord(records, hostName, type, zone);
  const body = JSON.stringify({ host: hostName, type, answer: value, ttl });

  let recordId;
  let action;
  if (hit?.id) {
    await call(cfg, `/domains/${encodeURIComponent(zone)}/records/${hit.id}`, { method: 'PUT', body });
    recordId = String(hit.id);
    action = 'updated';
  } else {
    const created = await call(cfg, `/domains/${encodeURIComponent(zone)}/records`, { method: 'POST', body });
    recordId = created.record?.id ? String(created.record.id) : '';
    action = 'created';
  }

  // 回读验证：API 返回 200 不代表值真的变了，回读不一致视为失败（防假成功）
  const verify = await call(cfg, `/domains/${encodeURIComponent(zone)}/records/${recordId}`);
  const vObj = verify.record || verify;
  const got = vObj.answer ?? '';
  if (got !== value) {
    throw new Error(`name.com: 下发后回读不一致（期望 ${value}，实际 ${got || '空'}）——host=${hostName} zone=${zone} action=${action} recordsTotal=${records.length}`);
  }
  return {
    zoneId: zone,
    recordId,
    content: value,
    action,
    detail: { zone, hostName, recordsTotal: records.length, matchedId: hit?.id || '', matchedAnswer: hit?.answer || '', verifyAnswer: got },
  };
}
