// 空适配器：只做排班计算与日志记录，不真正下发解析（用于演练 / 预览）
export const fields = [];

export async function resolve() {
  return { zoneId: '', recordId: '', content: '' };
}

export async function update({ rec, value }) {
  return { zoneId: rec.zone_id || '', recordId: rec.record_id || '', content: value, dryRun: true };
}
