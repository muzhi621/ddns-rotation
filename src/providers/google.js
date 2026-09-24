// Google Cloud DNS（Service Account RS256 JWT 换 OAuth token，WebCrypto 签名）
import { normalizeRecordName } from '../lib/time.js';

const API = 'https://dns.googleapis.com/dns/v1';

export const fields = [
  { key: 'service_account', label: 'Service Account JSON', secret: true, hint: 'GCP → IAM → 服务账号 → 密钥，粘贴完整 JSON 文件内容' },
  { key: 'project', label: 'GCP 项目 ID', hint: '如 my-project-123' },
];

const enc = new TextEncoder();
const b64url = (buf) => {
  const s = typeof buf === 'string' ? btoa(buf) : btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToBuf(pem) {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function accessToken(cfg) {
  const sa = JSON.parse(cfg.service_account);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/ndns.clouddns.readwrite',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const key = await crypto.subtle.importKey('pkcs8', pemToBuf(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`)));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${payload}.${sig}` }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Google 认证失败 HTTP ${res.status}：${json.error_description || json.error || ''}`);
  return json.access_token;
}

async function call(cfg, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken(cfg)}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google DNS: HTTP ${res.status} ${json.error?.message || ''}`);
  return json;
}

async function findZone(cfg, domain) {
  const r = await call(cfg, `/projects/${encodeURIComponent(cfg.project)}/managedZones?dnsName=${encodeURIComponent(domain)}.`);
  const hit = (r.managedZones || []).find((z) => z.dnsName === `${domain}.` || z.dnsName === domain);
  if (!hit) throw new Error(`Google DNS: 项目 ${cfg.project} 下找不到 ${domain} 的 Cloud DNS zone`);
  return String(hit.id);
}

async function findRecord(cfg, zone, fqdn, type) {
  const r = await call(cfg, `/projects/${encodeURIComponent(cfg.project)}/managedZones/${zone}/rrsets?name=${encodeURIComponent(fqdn)}.&type=${type}`);
  const hit = (r.rrsets || [])[0];
  return hit ? { content: (hit.rrdatas || [])[0] || '', ttl: hit.ttl } : null;
}

export async function resolve({ cfg, rec }) {
  const sub = normalizeRecordName(rec.record_name);
  const fqdn = sub === '@' ? rec.domain : `${sub}.${rec.domain}`;
  const zone = await findZone(cfg, rec.domain);
  const hit = await findRecord(cfg, zone, fqdn, rec.record_type || 'A');
  return { zoneId: zone, recordId: '', content: hit?.content || '' };
}

export async function update({ cfg, rec, value }) {
  const sub = normalizeRecordName(rec.record_name);
  const fqdn = sub === '@' ? rec.domain : `${sub}.${rec.domain}`;
  const ttl = Math.max(60, Number(rec.ttl) || 600);
  const type = rec.record_type || 'A';
  const zone = await findZone(cfg, rec.domain);
  const base = `/projects/${encodeURIComponent(cfg.project)}/managedZones/${zone}/rrsets`;

  // Google 用 PATCH（按 name+type 定位更新）；不存在时 POST 创建
  const patch = await fetch(`${API}${base}/${encodeURIComponent(fqdn + '.')}/${type}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await accessToken(cfg)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl, rrdatas: [value] }),
  });
  if (patch.ok) return { zoneId: zone, recordId: '', content: value };

  await call(cfg, `${base}`, { method: 'POST', body: { name: `${fqdn}.`, type, ttl, rrdatas: [value] } });
  return { zoneId: zone, recordId: '', content: value };
}
