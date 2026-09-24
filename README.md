# ddns-rotation · 多机多域名定时轮换解析调度器

> 场景：你有 2~5 台云服务器，自己用云厂商的定时开关机让它们**错峰轮流开机**；本系统负责**每天定时把域名解析切到当天开机（或当前在线）的那台机器**。
> 机器开关机不由本系统控制 —— 你只需在这里登记机器 IP 与在线时段，剩下的解析切换全自动。

运行在 **Cloudflare Worker + D1 + Cron Triggers**，零服务器成本，支持 Cloudflare / 阿里云 / 腾讯云 DNSPod / name.com 多 DNS 厂商。

---

## 一、核心概念

| 概念 | 说明 |
|---|---|
| **机器 machine** | 一台云服务器，主要字段就是「名称 + 公网 IP」。开关机由你在云厂商控制台设置 |
| **分组 group** | 一个分组 = **一组机器 + 一个或多个域名记录**。例如「A 组」= 机器 1/2/3 → 域名 `a.example.com`；「B 组」= 机器 4/5 → 域名 `b.example.com` |
| **解析记录 group_domain** | 分组下的具体一条 DNS 记录（域名 + 主机记录 + 厂商 + 凭据 + TTL） |
| **凭据 credential** | 某家 DNS 厂商的 API 密钥，可被多条记录复用 |

**一个分组可以同时挂多个域名（甚至跨厂商）**，它们永远被同步指向同一台当前值班机器的 IP。

### 两种排班模式

1. **`window` 按在线时段（推荐）**
   给每台机器填写在线时段（与你在云厂商设置的开机时间保持一致），系统按分组时区判断当前时间落在谁的时段内，就把域名解析给它。支持跨天（`22:00 → 06:00`）。
   > 例：机器1 `08:00-14:00`、机器2 `14:00-20:00`、机器3 `20:00-08:00`，三台错峰，域名自动跟着走。

2. **`rotate` 按天轮转**
   组内机器每天轮流值班，在 `switch_time`（默认 03:00）切换；切换时刻之前仍保留前一天的值班机器，避免与你的开机时间错位。可设 `anchor_date` 调整起始基准。

3. **`static` 固定首台**：不做轮换，只做记录。

**兜底**：所有机器都不在线时，解析到分组的 `fallback_ip`（留空则跳过并保持上一次的解析）。

---

## 二、部署（Cloudflare Workers）—— 三种方式任选

### 方式一：本地一键脚本（最省事）

```bash
npm run setup
```

脚本会依次完成：装依赖 → 检查登录（未登录自动拉起浏览器授权）→ 创建或复用 D1 数据库并把 `database_id` 写进 `wrangler.toml` → 建表 → 提示输入 `ADMIN_TOKEN` → 部署。全程只需按一次回车 + 输一个密码。

想手动分步（等价于脚本做的事）：

```bash
npm install
npx wrangler login                                        # 授权
npx wrangler d1 create ddns-rotation                      # 把返回的 database_id 填进 wrangler.toml
npx wrangler d1 execute ddns-rotation --remote --file=./schema.sql
npx wrangler secret put ADMIN_TOKEN                       # 管理后台密码
npm run deploy
```

### 方式二：Cloudflare 控制台 Workers Builds（连 Git 仓库自动部署）

即控制台 `Workers & Pages → 创建 → 连接 Git 仓库` 后出现的「设置您的应用程序」页面，按下面填：

| 字段 | 填写内容 |
|---|---|
| 项目名称 | `ddns-rotation`（保持） |
| 构建命令 | `npm ci && node scripts/inject-d1.mjs` |
| 部署命令 | `npx wrangler deploy && npx wrangler d1 execute ddns-rotation --remote --file=./schema.sql -y` |
| 预览命令 | **清空**（`wrangler preview` 在 wrangler v3 已移除，留着会报错） |
| 启用预览构建 | **关掉** |

> 部署命令后半段是**建表**（`CREATE TABLE IF NOT EXISTS`，幂等，重复跑不丢数据）。`wrangler deploy` 本身不会建表，漏掉这步会让后台所有接口报 `no such table`。
>
> **database_id 不用手动填**：`scripts/inject-d1.mjs` 会在构建时用构建环境自带的 Cloudflare 凭据查询 `ddns-rotation` 库的 UUID 并自动写入 `wrangler.toml`（前提是库里已存在同名 D1 数据库）。

点开「高级设置 → 变量和密钥」：

| 名称 | 值 | 说明 |
|---|---|---|
| `ADMIN_TOKEN`（部署成功后加） | 你的强密码 | 类型选**密钥**；Worker → 设置 → 变量和密钥 → 添加，保存即生效 |

> `D1_DATABASE_ID` 变量不再需要——构建脚本会自动查询注入。Dashboard 里之前加的名为 `D1_DATABASE_ID` 的 D1 绑定可以删掉（代码里的绑定名是 `DB`，以 wrangler.toml 为准）。

> **前置条件**：D1 数据库必须先存在。控制台 `Workers & Pages → D1 SQL database → Create`，名字填 `ddns-rotation`，创建后复制 **Database ID（UUID）** 粘贴到上面的变量里。
>
> **`ADMIN_TOKEN` 怎么设**：首次部署成功后，到 `Workers & Pages → ddns-rotation → 设置 → 变量和密钥 → 添加`，类型选「**密钥**」（加密），名称 `ADMIN_TOKEN`，值填你的密码，保存即生效（**不需要重新部署**）。(`wrangler secret put` 是交互式命令，无法放进构建命令里。)
>
> 这套流程走的是 Cloudflare 官方的 GitHub OAuth 集成，权限由集成自带，**不会再遇到之前 Actions 里 API Token 权限不足的问题**。

### 本地调试

```bash
cp .dev.vars.example .dev.vars                              # 写入 ADMIN_TOKEN
npx wrangler d1 execute ddns-rotation --file=./schema.sql   # 本地库
npm run dev                                                 # http://localhost:8787
```

部署完成后访问 `https://<你的-worker>.workers.dev` 打开管理后台，右上角填入 `ADMIN_TOKEN` 即可操作。

### 方式三：GitHub Actions（可选，需自己配 Cloudflare API Token）

推送到 `main` 即自动完成：**跑自测 → 注入 database_id → 迁移表结构 → 部署 Worker**。

先在仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 必填 | 怎么拿 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | Cloudflare 控制台 → My Profile → API Tokens → 用 **Edit Cloudflare Workers** 模板创建 |
| `D1_DATABASE_ID` | ✅ | `npx wrangler d1 list` 或 `npx wrangler d1 create ddns-rotation` 返回的 UUID |
| `CLOUDFLARE_ACCOUNT_ID` | 可选 | Workers 概览页右侧 Account ID；账号下只有一个账户时可省略 |
| `ADMIN_TOKEN` | 强烈建议 | 管理后台密码，会以 Worker Secret 注入；不设则后台不鉴权 |

配置好后手动触发一次：Actions → Deploy to Cloudflare Workers → **Run workflow**。

> 说明：Actions 与 Workers Builds 都是用 `sed` 把真实 `database_id` 注入 `wrangler.toml` 后再部署，仓库里保存的始终是占位符 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。本地部署用 `npm run setup` 会自动替换；若走手动分步，记得自己改 `wrangler.toml`。

**定时频率**：默认每 5 分钟对齐一次（`wrangler.toml` 的 `crons`）。因为更新是幂等的（目标 IP 没变就不调 API），频率高也不会浪费配额。想更省可改成 `*/10 * * * *` 或只在整点跑。

---

## 三、各厂商凭据字段

| 厂商 | provider | 所需字段 |
|---|---|---|
| Cloudflare | `cloudflare` | `api_token`（权限：Zone → DNS → Edit） |
| 阿里云云解析 | `aliyun` | `access_key_id`、`access_key_secret` |
| 腾讯云 DNSPod | `dnspod` | `secret_id`、`secret_key` |
| Google Cloud DNS | `google` | `service_account`（服务账号 JSON）、`project` |
| AWS Route 53 | `route53` | `access_key_id`、`secret_access_key` |
| GoDaddy | `godaddy` | `api_key`、`api_secret` |
| Namecheap | `namecheap` | `api_user`、`api_key`、`client_ip`（需 IP 白名单，Worker 出口不固定） |
| DigitalOcean | `digitalocean` | `api_token` |
| name.com | `name.com` | `username`、`api_token` |
| 演练 | `none` | 无（只算排班、写日志，不下发解析） |

`zone_id` / `record_id` 可留空，系统首次同步时会自动查询并回填到数据库。也可以在「DNS 凭据 → 连通测试」里先验证密钥与记录是否匹配。

> 注意：阿里云免费版 TTL 最小 600 秒；Cloudflare 开启橙云代理时 TTL 会被强制为 auto。

---

## 四、典型配置示例（2-3 台一个域名，其余一台另一个域名）

```
机器：HK-01 1.1.1.1 / HK-02 2.2.2.2 / HK-03 3.3.3.3 / HK-04 4.4.4.4 / HK-05 5.5.5.5

分组 A（域名 a.example.com，rotate 模式，每日 03:00 切换）
  └ 成员：HK-01、HK-02、HK-03
  └ 记录：cloudflare / a.example.com / @ / www

分组 B（域名 b.example.com，window 模式）
  └ 成员：HK-04（08:00-20:00）、HK-05（20:00-08:00）
  └ 记录：dnspod / b.example.com / @
```

每天 03:00 后，`a.example.com` 在三台之间轮转；`b.example.com` 按两台的在线时段自动切换。

---

## 五、HTTP API

所有接口需 `Authorization: Bearer <ADMIN_TOKEN>`（未设置 ADMIN_TOKEN 时不鉴权）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/meta` | 厂商/模式/时区元信息 |
| GET | `/api/overview` | 全量概览（机器、分组、当前指向、下次变化、记录当前值、日志） |
| GET/POST/PUT/DELETE | `/api/machines[/:id]` | 机器管理 |
| GET/POST/PUT/DELETE | `/api/groups[/:id]` | 分组管理 |
| PUT | `/api/groups/:id/members` | 全量保存组内成员与排班 |
| GET/POST/PUT/DELETE | `/api/domains[/:id]` | 解析记录管理 |
| GET/POST/PUT/DELETE | `/api/credentials[/:id]` | 凭据管理 |
| POST | `/api/credentials/:id/test` | 凭据连通性测试（查询记录当前值） |
| POST | `/api/sync` | 手动同步（body: `{force:true, group_id:1}`） |
| GET | `/api/preview?group_id=1` | 预览未来 7 天的排班结果 |
| GET | `/api/logs?limit=100` / POST `/api/logs/clear` | 日志 |

手动触发一次同步：

```bash
curl -X POST https://<worker>/api/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"force":true}'
```

---

## 六、排班算法自测

```bash
node test-scheduler.mjs
```

覆盖时段命中、跨天、按天轮转、切换时刻前后一致性、下次变化时刻、空组/全停用等边界。

---

## 七、注意事项

1. **开关机时间要留缓冲**：建议在时段边界前后各留几分钟（如开机 08:00，时段填 `08:05-13:55`），避免解析切过去了机器还没起来。
2. **TTL 决定生效速度**：TTL 600 意味着最长 10 分钟才生效，建议设 60~300（Cloudflare 橙云为 auto，切换几乎立即生效）。
3. **凭据安全**：密钥存放在 D1，管理后台用 `ADMIN_TOKEN` 保护，请务必设置一个强令牌。
4. **幂等**：只有目标 IP 变化时才调用厂商 API，不会刷爆接口配额。
