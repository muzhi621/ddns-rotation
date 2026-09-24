// 端到端 API 自测：用 Node 内置 SQLite 模拟 D1，直接调用 Worker 的 fetch
// 运行：node --experimental-sqlite test-api.mjs
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './src/index.js';
import { resolveTarget } from './src/scheduler.js';

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync('./schema.sql', 'utf8'));

const DB = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async all() {
            return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) };
          },
          async run() {
            const info = db.prepare(sql).run(...args);
            return { meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
          },
        };
      },
    };
  },
};

const env = { DB, ASSETS: { fetch: async () => new Response('ok') } };

let pass = 0, fail = 0;
const check = (name, actual, expect) => {
  const ok = String(actual) === String(expect);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  实际=${actual} 期望=${expect}`}`);
};

async function req(method, path, body) {
  const res = await worker.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    { waitUntil() {} },
  );
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// 1. 机器
const m1 = (await req('POST', '/api/machines', { name: 'HK-01', ip: '1.1.1.1' })).json.id;
const m2 = (await req('POST', '/api/machines', { name: 'HK-02', ip: '2.2.2.2' })).json.id;
const m3 = (await req('POST', '/api/machines', { name: 'HK-03', ip: '3.3.3.3' })).json.id;
check('创建 3 台机器', [m1, m2, m3].every((x) => Number(x) > 0), true);

// 2. 分组 A：window 模式，HK-01 全天在线优先
const gA = (await req('POST', '/api/groups', { name: 'A组', mode: 'window', timezone: 'Asia/Shanghai' })).json.id;
await req('PUT', `/api/groups/${gA}/members`, {
  items: [
    { machine_id: m1, window_start: '00:00', window_end: '23:59' },
    { machine_id: m2, window_start: '08:00', window_end: '09:00' },
  ],
});

// 3. 分组 B：rotate 模式，3 台轮转
const gB = (await req('POST', '/api/groups', { name: 'B组', mode: 'rotate', timezone: 'Asia/Shanghai', switch_time: '00:00', anchor_date: '1970-01-01' })).json.id;
await req('PUT', `/api/groups/${gB}/members`, {
  items: [{ machine_id: m1 }, { machine_id: m2 }, { machine_id: m3 }],
});

// 4. 凭据（none = 演练，不下发真实解析）
const cred = (await req('POST', '/api/credentials', { name: '演练', provider: 'none', config: {} })).json.id;

// 5. 解析记录：A 组两条（同一域名不同主机记录），B 组一条
await req('POST', '/api/domains', { group_id: gA, credential_id: cred, provider: 'none', domain: 'a.example.com', record_name: '@' });
await req('POST', '/api/domains', { group_id: gA, credential_id: cred, provider: 'none', domain: 'a.example.com', record_name: 'www' });
await req('POST', '/api/domains', { group_id: gB, credential_id: cred, provider: 'none', domain: 'b.example.com', record_name: '@' });

// 6. 同步
const s1 = (await req('POST', '/api/sync', {})).json.results;
check('同步覆盖 2 个分组', s1.length, 2);
check('A 组解析到 HK-01', s1[0].ip, '1.1.1.1');
check('A 组下发 2 条记录', s1[0].results.length, 2);
check('A 组记录全部成功', s1[0].results.every((r) => r.ok && r.changed), true);

const expectB = resolveTarget({ mode: 'rotate', timezone: 'Asia/Shanghai', switch_time: '00:00', anchor_date: '1970-01-01' }, [
  { machine_id: m1, machine_name: 'HK-01', machine_ip: '1.1.1.1', machine_enabled: 1 },
  { machine_id: m2, machine_name: 'HK-02', machine_ip: '2.2.2.2', machine_enabled: 1 },
  { machine_id: m3, machine_name: 'HK-03', machine_ip: '3.3.3.3', machine_enabled: 1 },
], new Date()).machine.machine_ip;
check('B 组按天轮转结果一致', s1[1].ip, expectB);

// 7. 幂等：第二次同步不应再变更
const s2 = (await req('POST', '/api/sync', {})).json.results;
check('二次同步无变更（幂等）', s2.every((g) => g.results.every((r) => r.changed === false)), true);

// 8. 强制同步
const s3 = (await req('POST', '/api/sync', { force: true })).json.results;
check('强制同步重新下发', s3[0].results.every((r) => r.changed === true), true);

// 9. 概览
const ov = (await req('GET', '/api/overview')).json;
check('概览含 2 个分组', ov.groups.length, 2);
check('概览 A 组当前指向 1.1.1.1', ov.groups[0].target.ip, '1.1.1.1');
check('概览记录当前值已回填', ov.groups[0].records.every((r) => r.current === '1.1.1.1'), true);
check('概览含下次变化时间', !!ov.groups[0].next, true);

// 10. 预览 7 天
const pv = (await req('GET', `/api/preview?group_id=${gB}`)).json;
check('预览 7 天', pv.preview[0].plan.length, 7);
check('预览每天指向不同机器', new Set(pv.preview[0].plan.map((p) => p.ip)).size >= 3, true);

// 11. 日志
const logs = (await req('GET', '/api/logs?limit=200')).json.logs;
check('日志写入 dns.update', logs.some((l) => l.action === 'dns.update'), true);

// 12. 兜底 IP：把 A 组成员全部停用后应走兜底
await req('PUT', `/api/groups/${gA}`, { fallback_ip: '9.9.9.9' });
await req('PUT', `/api/groups/${gA}/members`, { items: [] });
const s4 = (await req('POST', '/api/sync', { force: true })).json.results;
check('无在线机器时走兜底 IP', s4.find((g) => g.groupId === gA).ip, '9.9.9.9');

// 13. 删除级联
await req('DELETE', `/api/groups/${gA}`);
const ov2 = (await req('GET', '/api/overview')).json;
check('删除分组后仅剩 1 组', ov2.groups.length, 1);
const st = db.prepare("SELECT COUNT(*) c FROM state WHERE key LIKE 'rec:%'").get().c;
check('删除分组清理 state', st, 1);

// 14. meta 免鉴权 + 中文化 + 输入校验 + 凭据引用保护
const meta = (await req('GET', '/api/meta')).json;
check('meta 免鉴权可访问', Array.isArray(meta.providers) && meta.providers.length >= 5, true);
check('模式标签已中文化', meta.modes.length === 3 && meta.modes.every((m) => !/^[a-z]+$/.test(m.label)), true);

const badIp = await req('POST', '/api/machines', { name: 'bad', ip: '999.1.1.1' });
check('非法 IP 被拒绝', badIp.status, 400);

const badDomain = await req('POST', '/api/domains', { group_id: gB, credential_id: cred, provider: 'none', domain: 'not a domain' });
check('非法域名被拒绝', badDomain.status, 400);

const badWin = await req('PUT', `/api/groups/${gB}/members`, { items: [{ machine_id: m1, window_start: '8点', window_end: '20:00' }] });
check('非法时段被拒绝', badWin.status, 400);

const okWin = await req('PUT', `/api/groups/${gB}/members`, { items: [{ machine_id: m1, window_start: '22:00', window_end: '06:00' }] });
check('跨天时段被接受', okWin.status, 200);

const delCred = await req('DELETE', `/api/credentials/${cred}`);
check('被引用的凭据禁止删除', delCred.status, 400);

// 14b. 单条解析记录测试接口（none 演练 provider，resolve 返回空但不报错）
const recForTest = (await req('GET', '/api/domains')).json.domains.find((d) => d.group_id === gB);
const tRec = await req('POST', `/api/domains/${recForTest.id}/test`, {});
check('单条记录测试返回 ok', tRec.status === 200 && tRec.json.ok === true, true);
check('单条记录测试含 current 字段', 'current' in tRec.json, true);
const tNoCred = await req('POST', `/api/domains/${recForTest.id}/test`, {});
check('记录测试接口可调用', tNoCred.status, 200);

const recsB = (await req('GET', '/api/domains')).json.domains.filter((d) => d.group_id === gB);
for (const r of recsB) await req('DELETE', `/api/domains/${r.id}`);
const delCred2 = await req('DELETE', `/api/credentials/${cred}`);
check('解除引用后凭据可删除', delCred2.status, 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
