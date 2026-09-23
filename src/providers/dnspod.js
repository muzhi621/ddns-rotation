// 腾讯云 DNSPod / 云解析 DNS（TC3-HMAC-SHA256 签名）
import { tc3Sign, tc3Timestamp, tc3Date } from '../lib/signature.js';
import { normalizeRecordName } from '../lib/time.js';

const HOST = 'dnspod.tencentcloudapi.com';
const SERVICE = 'dnspod';
const VERSION = '2021-03-23';

export const fields = [
  { key: 'secret_id', label: 'SecretId' },
  { key: 'secret_key', label: 'SecretKey', secret: true },
];

async function call(cfg, action, payload) {
  const body = JSON.stringify(payload || {});
  const ts = tc3Timestamp();
  const auth = await tc3Sign({
    secretId: cfg.secret_id,
    secretKey: cfg.secret_key,
    service: SERVICE,
    host: HOST,
    payload: body,
    timestamp: ts,
    date: tc3Date(ts),
  });
  const res = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TC-Action': action,
      'X-TC-Version': VERSION,
      'X-TC-Timestamp': String(ts),
      Authorization: auth,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  const err = json.Response?.Error;
  if (err) throw new Error(`DNSPod: ${err.Code} ${err.Message || ''}`);
  if (!res.ok) throw new Error(`DNSPod: HTTP ${res.status}`);
  return json.Response || {};
}

export async function resolve({ cfg, rec }) {
  const sub = normalizeRecordName(rec.record_name);
  const r = await call(cfg, 'DescribeRecordList', {
    Domain: rec.domain,
    Subdomain: sub,
    RecordType: rec.record_type || 'A',
  });
  const hit = (r.RecordList || [])[0];
  return { zoneId: '', recordId: hit?.RecordId ? String(hit.RecordId) : '', content: hit?.Value || '' };
}

export async function update({ cfg, rec, value }) {
  const recordId = rec.record_id || (await resolve({ cfg, rec })).recordId;
  if (!recordId) throw new Error(`DNSPod: ${rec.domain} / ${rec.record_name} 未找到解析记录，请先在控制台创建或填写 record_id`);

  await call(cfg, 'ModifyRecord', {
    Domain: rec.domain,
    SubDomain: normalizeRecordName(rec.record_name),
    RecordType: rec.record_type || 'A',
    RecordLine: '默认',
    Value: value,
    TTL: Math.max(60, Number(rec.ttl) || 600),
    RecordId: Number(recordId),
  });
  return { zoneId: '', recordId, content: value };
}
