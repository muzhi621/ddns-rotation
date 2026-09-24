import * as cloudflare from './cloudflare.js';
import * as aliyun from './aliyun.js';
import * as dnspod from './dnspod.js';
import * as google from './google.js';
import * as route53 from './route53.js';
import * as godaddy from './godaddy.js';
import * as namecheap from './namecheap.js';
import * as digitalocean from './digitalocean.js';
import * as namedotcom from './namedotcom.js';
import * as none from './none.js';

export const PROVIDERS = {
  cloudflare,
  aliyun,
  dnspod,
  google,
  route53,
  godaddy,
  namecheap,
  digitalocean,
  'name.com': namedotcom,
  none,
};

export const PROVIDER_LABELS = {
  cloudflare: 'Cloudflare',
  aliyun: '阿里云云解析',
  dnspod: '腾讯云 DNSPod',
  google: 'Google Cloud DNS',
  route53: 'AWS Route 53',
  godaddy: 'GoDaddy',
  namecheap: 'Namecheap',
  digitalocean: 'DigitalOcean',
  'name.com': 'name.com',
  none: '不实际解析（演练）',
};

export function providerFields(name) {
  return (PROVIDERS[name] || none).fields || [];
}

export async function resolveRecord(provider, cfg, rec) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`未支持的 DNS 厂商：${provider}`);
  return p.resolve({ cfg, rec });
}

export async function applyRecord(provider, cfg, rec, value) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`未支持的 DNS 厂商：${provider}`);
  return p.update({ cfg, rec, value });
}
