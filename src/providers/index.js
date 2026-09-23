import * as cloudflare from './cloudflare.js';
import * as aliyun from './aliyun.js';
import * as dnspod from './dnspod.js';
import * as namedotcom from './namedotcom.js';
import * as none from './none.js';

export const PROVIDERS = {
  cloudflare,
  aliyun,
  dnspod,
  'name.com': namedotcom,
  none,
};

export const PROVIDER_LABELS = {
  cloudflare: 'Cloudflare',
  aliyun: '阿里云云解析',
  dnspod: '腾讯云 DNSPod',
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
