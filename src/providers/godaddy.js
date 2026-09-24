// GoDaddy DNS（sso-key 认证，PUT 即 UPSERT）
// 支持 zone 自动探测：domain 填完整子域（如 ddns1.example.com）时自动拆出父域名作 zone
import { normalizeRecordName } from '../lib/time.js';

const API = 'https://api.godaddy.com/v1';

export const fields = [
  { key: 'api_key', label: 'API Key', hint: 'developer.godaddy.com 创建（需勾选域名权限）' },
  { key: 'api_secret', label: 'API Secret', secret: true },
];

function headers(cfg) {
  return { Authorization: `sso-key ${cfg.api_key}:${cfg.api_secret}`, 'Content-Type': 'application/json' };
}

async function call(cfg, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: headers(cfg) });
  if (res.status === 404) return { notFound: true };
  const text = await res.text();
  if (!res.ok) throw new Error(`GoDaddy: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// zone 自动探测：完整域名不存在时，拆最左一段作主机名前缀，剩余作 zone
async function findZone(cfg, domain) {
  let r = await call(cfg, `/domains/${encodeURIComponent(domain)}`);
  if (!r.notFound) return { zone: domain, prefix: '' };
  const parts = domain.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(1).join('.');
    r = await call(cfg, `/domains/${encodeURIComponent(parent)}`);
    if (!r.notFound) return { zone: parent, prefix: parts[0] };
  }
  throw new Error(`GoDaddy: 账号下找不到 ${domain}（或其父域名），请确认域名托管在该 GoDaddy 账号`);
}

export async function resolve({ cfg, rec }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const rn = normalizeRecordName(rec.record_name);
  const host = prefix ? (rn === '@' ? prefix : `${prefix}.${rn}`) : rn;
  const r = await call(cfg, `/domains/${zone}/records/${rec.record_type || 'A'}/${host}`);
  if (r.notFound || !Array.isArray(r) || !r.length) return { zoneId: zone, recordId: '', content: '' };
  return { zoneId: zone, recordId: '', content: r[0].data || '' };
}

export async function update({ cfg, rec, value }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const rn = normalizeRecordName(rec.record_name);
  const host = prefix ? (rn === '@' ? prefix : `${prefix}.${rn}`) : rn;
  await call(cfg, `/domains/${zone}/records/${rec.record_type || 'A'}/${host}`, {
    method: 'PUT',
    body: JSON.stringify([{ data: value, ttl: Math.max(60, Number(rec.ttl) || 600) }]),
  });
  return { zoneId: zone, recordId: '', content: value };
}
