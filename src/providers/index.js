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

// 各厂商的 API 获取教程（前端凭据弹窗据此展示）
export const PROVIDER_DOCS = {
  cloudflare: {
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    title: '获取 Cloudflare API Token',
    steps: [
      '登录 Cloudflare，进入 My Profile → API Tokens',
      '点「Create Token」→ 选择「Edit zone DNS」模板',
      'Zone Resources 选择你的域名，创建后复制 Token 填入',
    ],
  },
  aliyun: {
    url: 'https://ram.console.aliyun.com/manage/ak',
    title: '获取阿里云 AccessKey',
    steps: [
      '登录阿里云控制台，进入 RAM 访问控制 → 用户 → 创建 AccessKey',
      '为安全建议新建一个仅授权「云解析 DNS (Alidns)」只读+修改权限的子账号',
      '复制 AccessKey ID 与 Secret 填入',
    ],
  },
  dnspod: {
    url: 'https://console.dnspod.cn/account/token',
    title: '获取腾讯云 DNSPod 密钥',
    steps: [
      '进入 DNSPod 控制台 → 安全设置 → API Token（或腾讯云 API 密钥）',
      '创建密钥，复制 SecretId 与 SecretKey 填入',
    ],
  },
  google: {
    url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    title: '获取 Google 服务账号 JSON',
    steps: [
      'GCP 控制台 → IAM 和管理 → 服务账号 → 创建服务账号',
      '为该账号授予「DNS 管理员」角色（Cloud DNS）',
      '点该账号 → 密钥 → 添加密钥 → 创建 JSON 密钥，下载后把整个文件内容粘贴进来',
      'Project ID 在控制台顶部项目选择器可见',
    ],
  },
  route53: {
    url: 'https://console.aws.amazon.com/iam/home#/users',
    title: '获取 AWS 访问密钥',
    steps: [
      'AWS IAM → 用户 → 创建用户，附加策略「AmazonRoute53FullAccess」',
      '安全凭证 → 创建访问密钥，复制 Access Key ID 与 Secret 填入',
    ],
  },
  godaddy: {
    url: 'https://developer.godaddy.com/keys',
    title: '获取 GoDaddy API Key',
    steps: [
      '进入 developer.godaddy.com → API Keys → Create New API Key',
      '环境选 Production，复制 Key 与 Secret 填入',
    ],
  },
  namecheap: {
    url: 'https://ap.www.namecheap.com/settings/tools/apiaccess',
    title: '获取 Namecheap API Key',
    steps: [
      'Namecheap 后台 → Profile → Tools → API Access',
      '开启 API 并生成 Key，同时把调用方 IP 加入白名单',
      '⚠️ Cloudflare Worker 出口 IP 不固定，Namecheap 白名单机制不适用，建议改用 DigitalOcean / Cloudflare',
    ],
  },
  digitalocean: {
    url: 'https://cloud.digitalocean.com/account/api/tokens',
    title: '获取 DigitalOcean API Token',
    steps: [
      'DigitalOcean → API → Tokens → Generate New Token',
      '勾选 Write 权限，复制 Token 填入',
    ],
  },
  'name.com': {
    url: 'https://www.name.com/account/settings/api',
    title: '获取 name.com API Token',
    steps: [
      'name.com → 账户 → 设置 → API',
      '创建 Token，复制用户名与 Token 填入',
    ],
  },
  none: {
    url: '',
    title: '演练模式（不实际解析）',
    steps: ['无需密钥，仅用于测试排班与解析流程，不会调用任何 DNS 厂商 API'],
  },
};

export function providerFields(name) {
  return (PROVIDERS[name] || none).fields || [];
}

export function providerDocs(name) {
  return PROVIDER_DOCS[name] || { url: '', title: '', steps: [] };
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
