// Namecheap DNS（XML API；注意需 API 白名单 IP，Worker 出口 IP 不固定，故优先建议 DigitalOcean/Cloudflare）
import { normalizeRecordName } from '../lib/time.js';

const API = 'https://api.namecheap.com/xml.response';

export const fields = [
  { key: 'api_user', label: 'API User（用户名）' },
  { key: 'api_key', label: 'API Key', hint: 'Namecheap 后台 → Profile → Tools → API Access' },
  { key: 'client_ip', label: '白名单 IP', hint: '⚠️ 需把调用方 IP 加入白名单；Cloudflare Worker 出口 IP 不固定，建议改用 DigitalOcean / Cloudflare' },
];

function splitDomain(domain) {
  const parts = domain.split('.');
  const tld = parts.pop();
  const sld = parts.pop();
  return { sld, tld, sub: parts.join('.') };
}

async function request(cfg, command, extra = {}) {
  const q = new URLSearchParams({ ApiUser: cfg.api_user, ApiKey: cfg.api_key, UserName: cfg.api_user, ClientIp: cfg.client_ip, Command: command, ...extra });
  const res = await fetch(`${API}?${q.toString()}`);
  const text = await res.text();
  const status = /Status="([^"]+)"/.exec(text)?.[1] || '';
  if (status !== 'OK') throw new Error(`Namecheap: ${status || 'ERROR'} ${text.slice(0, 200)}`);
  return text;
}

// Namecheap 的 HostName 语义：@ 表示根，子域名直接写完整前缀（不含 SLD.TLD）
function hostName(rec) {
  const { sub } = splitDomain(rec.domain);
  const rn = normalizeRecordName(rec.record_name);
  if (rn === '@') return sub ? sub : '@';
  return sub ? `${sub}.${rn}` : rn;
}

export async function resolve({ cfg, rec }) {
  const { sld, tld } = splitDomain(rec.domain);
  const xml = await request(cfg, 'namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
  const type = rec.record_type || 'A';
  const target = hostName(rec);
  const re = new RegExp(`HostName="([^"]*)"[^>]*Type="${type}"[^>]*Address="([^"]*)"`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === target) return { zoneId: '', recordId: '', content: m[2] };
  }
  return { zoneId: '', recordId: '', content: '' };
}

export async function update({ cfg, rec, value }) {
  const { sld, tld } = splitDomain(rec.domain);
  const ttl = Math.max(60, Number(rec.ttl) || 600);
  await request(cfg, 'namecheap.domains.dns.setHosts', {
    SLD: sld,
    TLD: tld,
    HostName1: hostName(rec),
    RecordType1: rec.record_type || 'A',
    Address1: value,
    TTL1: ttl,
  });
  return { zoneId: '', recordId: '', content: value };
}
