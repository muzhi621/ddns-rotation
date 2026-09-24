// GoDaddy DNS（sso-key 认证，PUT 即 UPSERT，最简单）
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

export async function resolve({ cfg, rec }) {
  const sub = normalizeRecordName(rec.record_name);
  const r = await call(cfg, `/domains/${rec.domain}/records/${rec.record_type || 'A'}/${sub}`);
  if (r.notFound || !Array.isArray(r) || !r.length) return { zoneId: '', recordId: '', content: '' };
  return { zoneId: '', recordId: '', content: r[0].data || '' };
}

export async function update({ cfg, rec, value }) {
  const sub = normalizeRecordName(rec.record_name);
  await call(cfg, `/domains/${rec.domain}/records/${rec.record_type || 'A'}/${sub}`, {
    method: 'PUT',
    body: JSON.stringify([{ data: value, ttl: Math.max(60, Number(rec.ttl) || 600) }]),
  });
  return { zoneId: '', recordId: '', content: value };
}
