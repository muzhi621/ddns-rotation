// AWS Route 53（SigV4 签名 + XML API；UPSERT 一步完成增改）
import { awsSigV4 } from '../lib/signature.js';
import { normalizeRecordName } from '../lib/time.js';

const HOST = 'route53.amazonaws.com';
const REGION = 'us-east-1'; // Route 53 控制面固定 us-east-1

export const fields = [
  { key: 'access_key_id', label: 'Access Key ID', hint: 'IAM 用户的访问密钥' },
  { key: 'secret_access_key', label: 'Secret Access Key', secret: true },
];

function authHeaders(cfg, method, path, query, body) {
  return awsSigV4({
    accessKey: cfg.access_key_id,
    secretKey: cfg.secret_access_key,
    method,
    host: HOST,
    path,
    query,
    body,
    service: 'route53',
    region: REGION,
    contentType: body ? 'application/xml' : '',
  });
}

async function callXml(cfg, method, path, query = '', body = '') {
  const { amzDate, authorization } = await authHeaders(cfg, method, path, query, body);
  const res = await fetch(`https://${HOST}${path}${query ? '?' + query : ''}`, {
    method,
    headers: {
      Authorization: authorization,
      'X-Amz-Date': amzDate,
      ...(body ? { 'Content-Type': 'application/xml' } : {}),
    },
    body: body || undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] || text.slice(0, 200);
    throw new Error(`Route 53: HTTP ${res.status} ${msg}`);
  }
  return text;
}

function pick(xml, tag) {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1] || '';
}

async function findZone(cfg, domain) {
  const xml = await callXml(cfg, 'GET', '/2013-04-01/hostedzones', `dnsname=${encodeURIComponent(domain)}.`);
  const id = pick(xml, 'Id');
  if (!id) throw new Error(`Route 53: 找不到 ${domain} 的 Hosted Zone（检查该域名是否托管在 Route 53）`);
  return id; // 形如 /hostedzone/Z123456
}

async function findRecord(cfg, zoneId, fqdn, type) {
  const xml = await callXml(cfg, 'GET', `${zoneId}/rrsets`, `name=${encodeURIComponent(fqdn)}.&type=${type}&maxitems=1`);
  const name = pick(xml, 'Name').replace(/\.$/, '').toLowerCase();
  if (name !== fqdn.toLowerCase()) return null;
  return { content: pick(xml, 'Value') };
}

export async function resolve({ cfg, rec }) {
  const sub = normalizeRecordName(rec.record_name);
  const fqdn = sub === '@' ? rec.domain : `${sub}.${rec.domain}`;
  const zoneId = await findZone(cfg, rec.domain);
  const hit = await findRecord(cfg, zoneId, fqdn, rec.record_type || 'A');
  return { zoneId, recordId: '', content: hit?.content || '' };
}

export async function update({ cfg, rec, value }) {
  const sub = normalizeRecordName(rec.record_name);
  const fqdn = sub === '@' ? rec.domain : `${sub}.${rec.domain}`;
  const zoneId = await findZone(cfg, rec.domain);
  const ttl = Math.max(60, Number(rec.ttl) || 600);
  const type = rec.record_type || 'A';
  const body =
    `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">` +
    `<ChangeBatch><Changes><Change><Action>UPSERT</Action><ResourceRecordSet>` +
    `<Name>${fqdn}.</Name><Type>${type}</Type><TTL>${ttl}</TTL>` +
    `<ResourceRecords><ResourceRecord><Value>${value}</Value></ResourceRecord></ResourceRecords>` +
    `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
  await callXml(cfg, 'POST', `${zoneId}/rrset`, '', body);
  return { zoneId, recordId: '', content: value };
}
