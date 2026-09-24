// DigitalOcean DNS（简洁 REST API，Bearer token，无 IP 白名单）
import { normalizeRecordName } from '../lib/time.js';

const API = 'https://api.digitalocean.com/v2';

export const fields = [
  { key: 'api_token', label: 'API Token', secret: true, hint: 'cloud.digitalocean.com → API → Generate Token（需 write 权限）' },
];

function headers(cfg) {
  return { Authorization: `Bearer ${cfg.api_token}`, 'Content-Type': 'application/json' };
}

async function call(cfg, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: headers(cfg), body: init.body ? JSON.stringify(init.body) : undefined });
  if (res.status === 404) return { notFound: true };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DigitalOcean: HTTP ${res.status} ${json.message || ''}`);
  return json;
}

async function findRecord(cfg, domain, fqdn, type) {
  const r = await call(cfg, `/domains/${domain}/records?name=${encodeURIComponent(fqdn)}&type=${type}`);
  const hit = (r.domain_records || []).find((x) => x.type === type && x.name === fqdn);
  return hit || null;
}

export async function resolve({ cfg, rec }) {
  const sub = normalizeRecordName(rec.record_name);
  const fqdn = sub === '@' ? rec.domain : `${sub}.${rec.domain}`;
  const hit = await findRecord(cfg, rec.domain, fqdn, rec.record_type || 'A');
  return { zoneId: '', recordId: hit?.id ? String(hit.id) : '', content: hit?.data || '' };
}

export async function update({ cfg, rec, value }) {
  const sub = normalizeRecordName(rec.record_name);
  const fqdn = sub === '@' ? rec.domain : `${sub}.${rec.domain}`;
  const ttl = Math.max(60, Number(rec.ttl) || 600);
  const hit = await findRecord(cfg, rec.domain, fqdn, rec.record_type || 'A');

  if (hit) {
    await call(cfg, `/domains/${rec.domain}/records/${hit.id}`, { method: 'PUT', body: { data: value, ttl } });
    return { zoneId: '', recordId: String(hit.id), content: value };
  }
  const created = await call(cfg, `/domains/${rec.domain}/records`, {
    method: 'POST',
    body: { type: rec.record_type || 'A', name: fqdn, data: value, ttl },
  });
  return { zoneId: '', recordId: created.domain_record?.id ? String(created.domain_record.id) : '', content: value };
}
