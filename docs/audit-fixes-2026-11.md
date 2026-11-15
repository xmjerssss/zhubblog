# Rin 仓库评审与修复总结（2026-11）

本文记录这一轮评审 + 修复的完整结论。三个阶段：

1. **只读评审**：不碰代码，列出优化点清单；
2. **按清单修复**：P0 安全 / P1 正确性 / P2 工程化；
3. **验收升级**：以「Cloudflare 账号全损、只留一个存储桶」为验收标准，实测并修复备份/恢复链路。

---

## 一、验收标准（阶段三提出）

> 「不管你怎么改，云存储里有我的备份；即使这个 CF 账号挂了，我重新建号、绑上同一个云存储，就能直接恢复成一模一样的博客包括所有数据。」

下面所有备份/恢复相关的改动都以这句话为唯一标准，并且是**用测试跑出来的**，不是看代码推断的。

---

## 二、备份/恢复：实测发现并修复的 7 个真问题

测试文件：`server/src/services/__tests__/backup.test.ts`、`backup-disaster-recovery.test.ts`（真实 SQLite + 假对象存储，模拟「旧实例导出 → 新实例恢复」全流程）。

| # | 问题（修复前真实表现） | 修复 |
| --- | --- | --- |
| 1 | 快照里的配置行带旧自增 id，与残留公共缓存行冲突 → 恢复直接 `UNIQUE constraint failed` 500 | 恢复时整表清空 `cache`，配置行丢弃 id 由数据库重新分配 |
| 2 | `visits` 不进快照也不清理 → 恢复后旧站访问明细残留，数据「不干净」 | `visits` 纳入快照，恢复时整体替换 |
| 3 | 坏备份文件也会先清库再报错 → 数据直接没了 | 恢复前 `assertValidSnapshot()` 校验结构与版本，不合法时一行不动 |
| 4 | 恢复后自己可能进不了后台：`users` 整表替换，若备份里的站长是另一个 GitHub 账号，操作者变普通用户 | 恢复前记下操作者身份，恢复后保证其仍为管理员（必要时新增/提权），并在回包里提示 |
| 5 | 新账号 `storages` 表为空 + 未配 `S3_*` → 恢复入口直接「未配置存储桶」，而加存储又要先进后台，容易卡死 | `getActiveStorageDriver()` 改为「启用的正常存储 → 环境变量默认存储 → 其他可解密存储」逐级降级；错误提示直接告诉用户怎么绑桶 |
| 6 | 换账号后 `JWT_SECRET` 变了 → 自定义存储 `secretEnc` 解不开 → 既是「活动存储」又读不出文件，媒体整站 404 | 无法解密的存储行自动跳过并降级到环境变量默认存储；`resolveFileSource()` 同样降级；回包 `warnings` 明确提示去重填 SecretKey |
| 7 | 恢复是不可逆操作，没有退路 | 恢复前把当前数据写入桶内 `backups/pre-restore.json`，失败提示里给出该路径；回包返回 `safetyBackup` |

另外补的运维能力：

- **每日自动备份**：定时任务新增 `backupCrontab()`，默认每 24 小时往桶里写一份全量快照（3 份滚动保留），间隔可用 `serverConfig.backup_auto_interval_hours` 调整，`0` 关闭。这样「桶里有备份」不再依赖用户手动点。
- **回包改为回读数据库**：`counts` 不再是照抄备份文件里的元数据，而是恢复后真实行数；新增 `warnings`（还需手动处理的事）。
- **后台提示**：恢复完成弹窗会列出真实条数、`pre-restore.json` 位置、以及「某存储密钥无法解密，请重填」之类的待办。

### 灾难恢复演练覆盖的场景

| 场景 | 断言 |
| --- | --- |
| 新账号 + 空 `storages` + 只配 `S3_*` | 全站内容、配置、文件索引、访问数据全部还原 |
| 恢复覆盖新站点已有数据 | 覆盖前自动写 `pre-restore.json`，内容正确 |
| 旧账号密钥解不开 | 恢复成功 + `warnings` 提示 + 存储列表仍可用 |
| 备份里的管理员是别人 | 当前操作者仍是管理员，旧站长也在 |
| 备份文件损坏 | 500 且现有数据一行不动 |
| 自动备份 | 24h 内不重复写、只留 3 份、可关闭、无存储时静默跳过 |

文档：`docs/docs/zh/guide/disaster-recovery.md` 与 `.../en/...`（含「事前要记下什么」「三步恢复」「收尾检查表」「FAQ」）。

---

## 三、P0 安全

| 项 | 处理 |
| --- | --- |
| OAuth 开放重定向 / 账号接管 | 新增 `utils/origin.ts`，回跳只允许同主机 / `FRONTEND_URL` / 本地开发地址；不再把 token 拼进 URL |
| 登录态可被 JS 读取 | 删除 `auth_token` 可读 cookie 与 localStorage 存储，统一 HttpOnly cookie；`callback` 页不再从 URL 取 token |
| 密码哈希 | 单轮 SHA-256 → PBKDF2（150k 迭代 + 随机盐），恒定时间比较，旧哈希登录后自动升级 |
| JWT | 增加 `exp` / `iss` / `aud`，并继续尊重 payload 自带的 `exp`（直传上传签名依赖它） |
| 登录爆破 | `/auth/login` 按 IP + 按账号双重限流（15 分钟窗口），超限 429 带 `Retry-After` |
| CORS | 由反射任意 Origin 改为白名单 |
| Markdown XSS | 新增 `rehypeSafeHtml`，移除 `script`、内联事件、`srcdoc`、`javascript:`，保留 katex / mermaid / 高亮 class |
| 评论隐私 | 公开列表不再返回 `guestEmail`；内容/昵称/站点链接做长度与协议校验 |
| 访问统计 | `visits.ip` 存加盐哈希；明细异步写（`runInBackground`），管理员与常见爬虫不计 PV/UV |
| 部署流水线 | 生产判断改用 `workflow_run` 元数据，禁止 fork 直进生产 |
| 配置体检 | 启动期 `config-guard` 检测示例/弱 `JWT_SECRET`、`ADMIN_PASSWORD`、缺失 `FRONTEND_URL` |

## 四、P1 正确性 / 数据一致性

- 列表缓存 key 增加访问者维度，管理员与游客不再互相污染。
- 文章详情写库异步化，并跳过管理员 / 爬虫浏览。
- `users.openid` 唯一索引 + `users.username` 索引（迁移 `0014.sql`）。
- `hono-middleware` 里重复构建的 `clientConfig` 去重。

## 五、P2 工程化 / 性能

- 删除从未生效的 `format:check` / `format:write`（仓库没有接入格式化工具），CI 不再空转。
- 合并 `ci.yml` / `test.yml` 为单一 `test.yml`，5 个 job → 3 个。
- `@rin/api`、`@rin/config`、`@rin/ui` 的 `check` 纳入 turbo。
- 后台页面 `React.lazy` + `Suspense`：首屏 JS 6.36 MB → 2.04 MB（vite 构建实测）。
- 新增 `deploy:server` / `deploy:client`；补齐日语缺失的 7 个 `login.*` key；新增 `.env.example`。

---

## 六、验证结果

| 检查 | 结果 |
| --- | --- |
| `bun test`（整仓） | **492 pass / 0 fail**（54 个文件） |
| `tsc --noEmit`（server） | 0 错误 |
| `tsc --noEmit`（client） | 0 错误 |
| `vite build`（client） | 成功，`index-*.js` 2,035 kB（基线单文件 6,361 kB） |

> 沙箱内 `bun install` 不可用（大量 ConnectionClosed），验证在 `/tmp/verify` 里用 pnpm + `node-linker=hoisted` 完成，源码每次从本仓库同步；仓库本身不引入 pnpm 文件。

## 七、第二轮：把遗留清单清掉

| 遗留项 | 处理结果 |
| --- | --- |
| 28 处 `console.log` | 新增 `server/src/utils/logger.ts`（`debugLog` / `logInfo` / `logWarn` / `logError`），热路径日志默认静默，`LOG_DEBUG=1` 时才输出；`fetch` / `scheduled` / `queue` 三个入口统一 `configureLogging(env)` |
| `comments.approved` 一直是 1 | 完整接线：`comment.require_approval` 开关（默认关）→ 非管理员的评论入待审核；列表对游客过滤未审核、管理员可见；新增 `GET /comment/pending` 与 `PATCH /comment/:id/approve`；后台设置页新增开关与审核列表（通过 / 删除）；前台提交后提示「等待审核」 |
| `client/index.html` | 补 `<title>` / description / theme-color / color-scheme，注释说明 `no-referrer` 的取舍；**移除硬编码的上游 Umami 统计 ID**（改成 `VITE_UMAMI_WEBSITE_ID` 才加载，否则所有 fork 的访客数据都会进上游账号） |
| `backup.ts` 1251 行 | 拆成 `backup-core.ts`（452 行，纯逻辑：快照/恢复校验/云端写入/自动备份/密钥体检）+ `backup.ts`（836 行，只留路由），旧导入路径继续可用 |
| `footer.tsx` 784 行 | 背景音乐（APlayer 加载、歌单拉取、错误跳过）抽成 `components/site-music-player.tsx` 的 `useSiteMusicPlayer()`，footer 降到 ~660 行 |
| `components` vs `packages/ui` 重叠 | 删掉 5 个只做转发的 shim（`button/icon/input/loading/padding`），全仓 25 处导入改为直接引 `@rin/ui`；`AGENTS.md` 明确「通用原语只放 `packages/ui`，`client/src/components` 只放应用级组合」 |
| README 与 `deploy:*` 不一致 | 修正工作流清单（`ci.yml` 已删、`build/clean/release/docs` 补齐），新增「Backup and Disaster Recovery」小节与双语文档链接 |
| 语言标记 | `<html lang>` 跟随 i18n 实际语言，读屏软件与搜索引擎不再被固定 `en` 误导 |

剩下一项：`settings.tsx`（~1680 行）仍未拆分。备份/恢复那一大块状态与弹窗高度耦合，短期内强拆反而有回归风险，因此保留，作为后续单独任务。

## 八、第二轮验证

| 检查 | 结果 |
| --- | --- |
| `bun test` 整仓 | **496 pass / 0 fail**（54 个文件，新增 4 个评论审核用例） |
| `tsc --noEmit`（server / client） | 均 0 错误 |
| `vite build`（client） | 成功 |
