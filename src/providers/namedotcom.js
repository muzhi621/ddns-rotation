// name.com API v4（Basic Auth）
import { normalizeRecordName } from '../lib/time.js';

const EP = 'https://api.name.com/v4';

export const fields = [
  { key: 'username', label: '用户名' },
  { key: 'api_token', label: 'API Token', secret: true },
];

function authHeader(cfg) {
  return `Basic ${btoa(`${cfg.username}:${cfg.api_token}`)}`;
}

function hostOf(rec) {
  const n = normalizeRecordName(rec.record_name);
  return n === '@' ? '' : n;
}

async function call(cfg, path, init = {}) {
  const res = await fetch(`${EP}${path}`, {
    ...init,
    headers: { Authorization: authHeader(cfg), 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`name.com: ${json.message || `HTTP ${res.status}`}`);
  return json;
}

export async function resolve({ cfg, rec }) {
  const json = await call(cfg, `/domains/${encodeURIComponent(rec.domain)}/records`);
  const want = hostOf(rec);
  const hit = (json.records || []).find(
    (r) => (r.type || '').toUpperCase() === (rec.record_type || 'A').toUpperCase() && (r.host || '') === want,
  );
  return { zoneId: '', recordId: hit?.id ? String(hit.id) : '', content: hit?.answer || '' };
}

export async function update({ cfg, rec, value }) {
  const recordId = rec.record_id || (await resolve({ cfg, rec })).recordId;
  if (!recordId) throw new Error(`name.com: ${rec.domain} / ${rec.record_name} 未找到 A 记录，请先创建或填写 record_id`);

  await call(cfg, `/domains/${encodeURIComponent(rec.domain)}/records/${recordId}`, {
    method: 'PUT',
    body: JSON.stringify({
      host: hostOf(rec),
      type: rec.record_type || 'A',
      answer: value,
      ttl: Math.max(60, Number(rec.ttl) || 300),
    }),
  });
  return { zoneId: '', recordId, content: value };
}
