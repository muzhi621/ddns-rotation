// 阿里云云解析 DNS（Alidns OpenAPI，HMAC-SHA1 签名）
import { aliSign } from '../lib/signature.js';
import { normalizeRecordName } from '../lib/time.js';

const EP = 'https://alidns.aliyuncs.com/';

export const fields = [
  { key: 'access_key_id', label: 'AccessKey ID' },
  { key: 'access_key_secret', label: 'AccessKey Secret', secret: true },
];

async function call(cfg, action, extra = {}) {
  const params = {
    Action: action,
    Format: 'JSON',
    Version: '2015-01-09',
    AccessKeyId: cfg.access_key_id,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extra,
  };
  const { query } = await aliSign(params, cfg.access_key_secret, 'GET');
  const res = await fetch(`${EP}?${query}`);
  const json = await res.json().catch(() => ({}));
  if (json.Code && json.Code !== '200') throw new Error(`阿里云: ${json.Code} ${json.Message || ''}`);
  if (!res.ok) throw new Error(`阿里云: HTTP ${res.status}`);
  return json;
}

export async function resolve({ cfg, rec }) {
  const rr = normalizeRecordName(rec.record_name);
  const json = await call(cfg, 'DescribeDomainRecords', {
    DomainName: rec.domain,
    RRKeyWord: rr,
    TypeKeyWord: rec.record_type || 'A',
  });
  const list = json.DomainRecords?.Record || [];
  const hit = list.find((r) => r.RR === rr && (r.Type || 'A') === (rec.record_type || 'A')) || list[0];
  return { zoneId: '', recordId: hit?.RecordId || '', content: hit?.Value || '' };
}

export async function update({ cfg, rec, value }) {
  const recordId = rec.record_id || (await resolve({ cfg, rec })).recordId;
  if (!recordId) throw new Error(`阿里云: ${rec.domain} / ${rec.record_name} 未找到解析记录，请先在控制台创建或填写 record_id`);

  await call(cfg, 'UpdateDomainRecord', {
    RecordId: recordId,
    RR: normalizeRecordName(rec.record_name),
    Type: rec.record_type || 'A',
    Value: value,
    TTL: String(Math.max(600, Number(rec.ttl) || 600)), // 阿里云最小 TTL 600
  });
  return { zoneId: '', recordId, content: value };
}
