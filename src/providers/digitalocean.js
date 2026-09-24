// DigitalOcean DNS（简洁 REST API，Bearer token，无 IP 白名单）
// 支持 zone 自动探测：domain 填完整子域（如 ddns1.example.com）时自动拆出父域名作 zone
import { normalizeRecordName } from '../lib/time.js';

const API = 'https://api.digitalocean.com/v2';

export const fields = [
  { key: 'api_token', label: 'API Token', secret: true, hint: 'cloud.digitalocean.com → API → Generate Token（需 write 权限）' },
];

function headers(cfg) {
  return { Authorization: `Bearer ${cfg.api_token}`, 'Content-Type': 'application/json' };
}

async function call(cfg, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: headers(cfg),
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 404) return { notFound: true };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DigitalOcean: HTTP ${res.status} ${json.message || ''}`);
  return json;
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
  throw new Error(`DigitalOcean: 账号下找不到 ${domain}（或其父域名）的 DNS zone，请先在 DO 控制台把域名加入 DNS`);
}

// DO 的 record.name 是相对主机名（'@' 或 'ddns1'）
async function findRecord(cfg, zone, relName, type) {
  const r = await call(cfg, `/domains/${zone}/records?name=${encodeURIComponent(relName)}&type=${type}`);
  const hit = (r.domain_records || []).find((x) => x.type === type && (x.name || '@') === relName);
  return hit || null;
}

export async function resolve({ cfg, rec }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const rn = normalizeRecordName(rec.record_name);
  const rel = prefix ? (rn === '@' ? prefix : `${prefix}.${rn}`) : rn;
  const hit = await findRecord(cfg, zone, rel, rec.record_type || 'A');
  return { zoneId: zone, recordId: hit?.id ? String(hit.id) : '', content: hit?.data || '' };
}

export async function update({ cfg, rec, value }) {
  const { zone, prefix } = await findZone(cfg, rec.domain);
  const rn = normalizeRecordName(rec.record_name);
  const rel = prefix ? (rn === '@' ? prefix : `${prefix}.${rn}`) : rn;
  const ttl = Math.max(60, Number(rec.ttl) || 600);
  const hit = await findRecord(cfg, zone, rel, rec.record_type || 'A');

  if (hit) {
    await call(cfg, `/domains/${zone}/records/${hit.id}`, { method: 'PUT', body: { data: value, ttl } });
    return { zoneId: zone, recordId: String(hit.id), content: value };
  }
  const created = await call(cfg, `/domains/${zone}/records`, {
    method: 'POST',
    body: { type: rec.record_type || 'A', name: rel, data: value, ttl },
  });
  return { zoneId: zone, recordId: created.domain_record?.id ? String(created.domain_record.id) : '', content: value };
}
