// 时区感知的时间工具：所有排班判定都以分组配置的时区为准（默认 Asia/Shanghai）

export function zonedParts(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const p = {};
    for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
    return {
      year: +p.year,
      month: +p.month,
      day: +p.day,
      hour: +p.hour,
      minute: +p.minute,
      minuteOfDay: (+p.hour) * 60 + (+p.minute),
    };
  } catch {
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    };
  }
}

export function minutesOf(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':');
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}

// 支持跨天窗口，如 22:00 -> 06:00
export function inWindow(minuteOfDay, start, end) {
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === e) return true; // 全天
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}

export function dayIndex(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

export function parseDayIndex(dateStr) {
  if (!dateStr) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return 0;
  return dayIndex(+m[1], +m[2], +m[3]);
}

// 规范化域名记录名：'@' 与空串都表示根域名
export function normalizeRecordName(name) {
  const n = String(name || '').trim();
  return n === '' || n === '@' ? '@' : n.replace(/^\./, '');
}

export function fqdn(domain, recordName) {
  const rn = normalizeRecordName(recordName);
  return rn === '@' ? domain : `${rn}.${domain}`;
}
