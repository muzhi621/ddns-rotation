// pruneLogs 边界测试：node test-prune.mjs
import { pruneLogs } from './src/scheduler.js';

let pass = 0, fail = 0;
const check = (name, actual, expect) => {
  const ok = String(actual) === String(expect);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  实际=${actual} 期望=${expect}`}`);
};

// 记录 DB.prepare 调用，模拟 D1 返回
function mockEnv() {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          run() {
            calls.push({ sql, bound });
            return { meta: { changes: 7 } };
          },
        };
      },
    },
  };
  return { env, calls };
}

// 1. days 非法值（0 / 负数 / 非数字 / undefined）→ 跳过，返回 0
for (const bad of [0, -1, 'abc', undefined, null, NaN, 0.5]) {
  const { env, calls } = mockEnv();
  const r = await pruneLogs(env, bad);
  check(`非法 days=${String(bad)} 跳过`, r, 0);
  check(`非法 days=${String(bad)} 未执行 SQL`, calls.length, 0);
}

// 2. 正常 days=30 → 执行 DELETE，绑定 '-30 days'，返回 changes
{
  const { env, calls } = mockEnv();
  const r = await pruneLogs(env, 30);
  check('days=30 返回删除条数', r, 7);
  check('days=30 SQL 含 DELETE', calls[0].sql.includes('DELETE FROM logs'), true);
  check('days=30 绑定 -30 days', calls[0].bound[0], '-30 days');
}

// 3. 字符串数字 '7' → 正常处理为 7 天
{
  const { env, calls } = mockEnv();
  const r = await pruneLogs(env, '7');
  check("days='7' 绑定 -7 days", calls[0].bound[0], '-7 days');
  check("days='7' 返回条数", r, 7);
}

// 4. 小数 15.9 → 向下取整 15
{
  const { env, calls } = mockEnv();
  await pruneLogs(env, 15.9);
  check('days=15.9 取整为 15', calls[0].bound[0], '-15 days');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
