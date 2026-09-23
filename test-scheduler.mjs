// 排班算法本地自测：node test-scheduler.mjs
import { resolveTarget, nextChange } from './src/scheduler.js';

let pass = 0, fail = 0;
const check = (name, actual, expect) => {
  const ok = String(actual) === String(expect);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  实际=${actual} 期望=${expect}`}`);
};

const mk = (id, name, ip, s, e) => ({ machine_id: id, machine_name: name, machine_ip: ip, window_start: s, window_end: e, enabled: 1, machine_enabled: 1 });

const members = [mk(1, 'A', '1.1.1.1', '08:00', '20:00'), mk(2, 'B', '2.2.2.2', '20:00', '08:00')];
const win = { id: 1, name: 'g', mode: 'window', timezone: 'Asia/Shanghai' };

// Asia/Shanghai = UTC+8
check('window 12:00 -> A', resolveTarget(win, members, new Date('2026-09-23T04:00:00Z')).machine.machine_name, 'A');
check('window 22:00 -> B', resolveTarget(win, members, new Date('2026-09-23T14:00:00Z')).machine.machine_name, 'B');
check('window 03:00(跨天) -> B', resolveTarget(win, members, new Date('2026-09-22T19:00:00Z')).machine.machine_name, 'B');
check('window 07:59 -> B', resolveTarget(win, members, new Date('2026-09-22T23:59:00Z')).machine.machine_name, 'B');

const rot = { id: 2, name: 'r', mode: 'rotate', timezone: 'Asia/Shanghai', switch_time: '03:00', anchor_date: '1970-01-01' };
const rm = [mk(1, 'M1', '1.1.1.1'), mk(2, 'M2', '2.2.2.2'), mk(3, 'M3', '3.3.3.3')];
const d1 = new Date('2026-09-23T04:00:00Z'); // 12:00 CST，已过 03:00
const d2 = new Date('2026-09-24T04:00:00Z');
const d1b = new Date('2026-09-23T02:00:00Z'); // 10:00 CST，已过切换
const before = new Date('2026-09-23T18:00:00Z'); // 次日 02:00 CST，未到 03:00 → 沿用前一天
const t1 = resolveTarget(rot, rm, d1).machine.machine_name;
const t2 = resolveTarget(rot, rm, d2).machine.machine_name;
console.log(`  rotate: 09-23=${t1}  09-24=${t2}`);
check('rotate 相邻两天不同机器', t1 !== t2, true);
check('rotate 同一天内切换前后一致', resolveTarget(rot, rm, d1).machine.machine_name, resolveTarget(rot, rm, d1b).machine.machine_name);
check('rotate 切换时刻前沿用前一天', resolveTarget(rot, rm, before).machine.machine_name, t1);
check('rotate 三天后回到同一台', resolveTarget(rot, rm, new Date('2026-09-26T04:00:00Z')).machine.machine_name, t1);

const nc = nextChange(rot, rm, d1);
check('rotate 下次切换约 15 小时后', nc.inMinutes, 900); // 12:00 -> 次日03:00
const nw = nextChange(win, members, new Date('2026-09-23T04:00:00Z'));
check('window 当前机器 8 小时后下线', nw.inMinutes, 480);

check('空组返回 null', resolveTarget(win, [], d1).machine, null);
check('全停用返回 null', resolveTarget(win, [{ ...mk(9, 'X', '9.9.9.9', '00:00', '23:59'), machine_enabled: 0 }], d1).machine, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
