// 阿里云（HMAC-SHA1 旧签名）与腾讯云 TC3（HMAC-SHA256）签名实现，基于 WebCrypto

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(keyData, msg, hash = 'SHA-256', rawKey = false) {
  const key = rawKey
    ? keyData
    : await crypto.subtle.importKey('raw', typeof keyData === 'string' ? enc.encode(keyData) : keyData, { name: 'HMAC', hash }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, typeof msg === 'string' ? enc.encode(msg) : msg);
}

async function sha256hex(msg) {
  return hex(await crypto.subtle.digest('SHA-256', typeof msg === 'string' ? enc.encode(msg) : msg));
}

/* ---------------- 阿里云 ---------------- */

export function aliPercentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%2B')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

export function aliBuildQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${aliPercentEncode(k)}=${aliPercentEncode(params[k])}`)
    .join('&');
}

export async function aliSign(params, accessKeySecret, method = 'GET') {
  const canonical = aliBuildQuery(params);
  const stringToSign = `${method}&${aliPercentEncode('/')}&${aliPercentEncode(canonical)}`;
  const sig = await hmac(`${accessKeySecret}&`, stringToSign, 'SHA-1');
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { query: `${canonical}&Signature=${aliPercentEncode(b64)}`, signature: b64 };
}

/* ---------------- 腾讯云 TC3 ---------------- */

export async function tc3Sign({ secretId, secretKey, service, host, payload, timestamp, date }) {
  const hashedPayload = await sha256hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, await sha256hex(canonicalRequest)].join('\n');

  const secretDate = await hmac(`TC3${secretKey}`, date);
  const secretService = await hmac(secretDate, service, 'SHA-256', true);
  const secretSigning = await hmac(secretService, 'tc3_request', 'SHA-256', true);
  const signature = hex(await hmac(secretSigning, stringToSign, 'SHA-256', true));

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function tc3Timestamp(date = new Date()) {
  return Math.floor(date.getTime() / 1000);
}

export function tc3Date(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
