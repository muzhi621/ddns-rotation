// Cloudflare DNS（推荐：与被部署的 Worker 同平台，延迟最低）
import { fqdn, normalizeRecordName } from '../lib/time.js';

const API = 'https://api.cloudflare.com/client/v4';

export const fields = [
  { key: 'api_token', label: 'API Token', hint: '权限：Zone → DNS → Edit', secret: true },
];

async function cf(cfg, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.api_token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = (json.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare: ${msg}`);
  }
  return json;
}

export async function resolve({ cfg, rec }) {
  let zoneId = rec.zone_id;
  if (!zoneId) {
    const z = await cf(cfg, `/zones?name=${encodeURIComponent(rec.domain)}`);
    zoneId = (z.result || [])[0]?.id;
    if (!zoneId) throw new Error(`Cloudflare: 找不到域名 ${rec.domain} 对应的 Zone`);
  }
  const name = fqdn(rec.domain, rec.record_name);
  const list = await cf(cfg, `/zones/${zoneId}/dns_records?type=${rec.record_type || 'A'}&name=${encodeURIComponent(name)}`);
  const hit = (list.result || [])[0];
  return { zoneId, recordId: hit?.id || '', content: hit?.content || '' };
}

export async function update({ cfg, rec, value }) {
  const { zoneId, recordId } = rec.record_id
    ? { zoneId: rec.zone_id, recordId: rec.record_id }
    : await resolve({ cfg, rec });

  if (!recordId) throw new Error(`Cloudflare: ${fqdn(rec.domain, rec.record_name)} 未找到 A 记录，请先在 CF 创建或填写 record_id`);

  const proxied = !!rec.proxied;
  const body = {
    type: rec.record_type || 'A',
    name: normalizeRecordName(rec.record_name) === '@' ? rec.domain : fqdn(rec.domain, rec.record_name),
    content: value,
    ttl: proxied ? 1 : Math.max(60, Number(rec.ttl) || 600), // 开启代理时 CF 强制 ttl=1(auto)
    proxied,
  };
  const json = await cf(cfg, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'PATCH', body: JSON.stringify(body) });
  return { zoneId, recordId, content: json.result?.content || value };
}
