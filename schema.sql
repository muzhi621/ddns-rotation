-- ddns-rotation / D1 schema
-- 执行：npx wrangler d1 execute ddns-rotation --file=./schema.sql

CREATE TABLE IF NOT EXISTS machines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'window',      -- window=按在线时段 | rotate=按天轮转 | static=固定首台
  timezone     TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  switch_time  TEXT NOT NULL DEFAULT '03:00',        -- rotate 模式的每日切换时刻
  anchor_date  TEXT NOT NULL DEFAULT '1970-01-01',   -- rotate 模式轮转基准日
  fallback_ip  TEXT NOT NULL DEFAULT '',             -- 无机器在线时的兜底 IP
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_machines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     INTEGER NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  machine_id   INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL DEFAULT '00:00',           -- window 模式：本机在线起始 HH:MM
  window_end   TEXT NOT NULL DEFAULT '23:59',           -- window 模式：本机在线结束 HH:MM（支持跨天）
  sort_order   INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  UNIQUE(group_id, machine_id)
);

CREATE TABLE IF NOT EXISTS credentials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL,                     -- cloudflare | aliyun | dnspod | name.com | none
  config     TEXT NOT NULL DEFAULT '{}',        -- JSON，字段见 README
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_domains (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL REFERENCES groups(id)      ON DELETE CASCADE,
  credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'cloudflare',
  domain        TEXT NOT NULL,
  record_name   TEXT NOT NULL DEFAULT '@',
  record_type   TEXT NOT NULL DEFAULT 'A',
  ttl           INTEGER NOT NULL DEFAULT 600,
  proxied       INTEGER NOT NULL DEFAULT 0,
  zone_id       TEXT NOT NULL DEFAULT '',   -- 留空自动查询并回填
  record_id     TEXT NOT NULL DEFAULT '',   -- 留空自动查询并回填
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  level      TEXT NOT NULL DEFAULT 'info',
  group_id   INTEGER,
  machine_id INTEGER,
  action     TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_gm_group ON group_machines(group_id);
CREATE INDEX IF NOT EXISTS idx_gd_group ON group_domains(group_id);
