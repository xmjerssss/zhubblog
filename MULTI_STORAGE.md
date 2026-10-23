# 多存储（自定义 R2 / S3 / WebDAV）说明

## 它做了什么

- 后台新增 **「存储管理」**（`/admin/storage`），可添加任意数量的：
  - Cloudflare R2（其他账号或其他桶，走 S3 API）
  - S3 兼容存储（AWS S3、MinIO、Backblaze B2、阿里云 OSS、腾讯云 COS 等）
  - WebDAV（坚果云、Nextcloud、Alist 等）
- 部署时通过环境变量绑定的 R2（`R2_BUCKET`）或 `S3_*` 变量 **保留不变，作为兜底存储**。
- 编辑器里上传的 **图片、视频、任意文件（附件）** 都走同一条链路。

## 上传规则

1. 按「优先级」从高到低，选择已启用、没有标记为"已满"、没超过容量上限的自定义存储。
2. 某个存储写入失败会自动换下一个；返回 507 / QuotaExceeded 等容量错误时，该存储会被标记为"已满"，不再选用（在后台点"重置状态"可恢复）。
3. 没有可用的自定义存储时，才写入环境变量绑定的默认存储。

## 为什么换桶后旧文章依然能显示

- 文章里保存的是 `/api/blob/<key>`，不包含任何桶地址。
- 数据库新表 `storage_files` 记录每个文件实际所在的存储；访问时按 key 查到所在存储再读取。
- 旧版本上传的文件（没有数据库记录）仍然按原来的方式从默认存储读取，文章不用改。
- 想"换桶"时请 **停用** 旧存储，不要删除：停用后不再往里上传，但里面的文件依然可访问。删除有文件的存储会被拒绝（需要二次确认强制删除）。

## 大文件（视频）

- 小于 8MB：经服务器中转上传。
- 8MB ~ 2GB：优先 **浏览器直传** 到 S3/R2 存储桶（预签名 URL），不受 Worker 约 100MB 请求体限制。
  存储桶需要配置 CORS，示例：

  ```json
  [{
    "AllowedOrigins": ["https://你的博客域名"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }]
  ```
- 没配 CORS、或使用 WebDAV 时，自动回退到服务器中转（上限约 95MB）。
- 读取支持 `Range`，视频可以拖动进度条。
- 存储设置了「公开访问域名」并开启「直链跳转」后，访问 `/api/blob/…` 会 302 到存储自己的域名，节省 Worker 流量（文章里的链接不变）。

## 部署 / 升级

1. 覆盖代码后正常执行 `bun run deploy`，会自动执行迁移 `server/sql/0013.sql`（新增 `storages`、`storage_files` 两张表）。
   本地开发执行 `bun run db:migrate`。
2. 无需新增环境变量。存储密钥使用 AES-GCM 加密后存入 D1，主密钥默认由 `JWT_SECRET` 派生；
   如果以后想更换 `JWT_SECRET` 又不想重填存储密钥，请先设置独立的 `STORAGE_SECRET`。

## 安全

- 存储管理接口仅管理员可用；接口永远不会返回 Secret，只返回 `hasSecret`。
- 通过 `/api/blob` 提供的 HTML / SVG / JS 等可执行类型一律强制下载，并加 `X-Content-Type-Options: nosniff`，避免上传文件在站点域名下执行脚本。
- 普通文件下载时使用上传时的原始文件名。

## 改动清单

服务端
- `server/sql/0013.sql`、`server/src/db/schema.ts`：新增 `storages`、`storage_files` 表
- `server/src/utils/storage-drivers.ts`：S3 / WebDAV / 环境默认存储驱动、连接测试
- `server/src/utils/storage-manager.ts`：选桶、故障切换、容量限制、直传、读取定位
- `server/src/utils/storage-secrets.ts`：密钥加密
- `server/src/utils/storage.ts`：默认存储新增 Range 读取、删除
- `server/src/services/storage.ts`：上传 / 预签名直传 / 直传确认 / 读取
- `server/src/services/storage-admin.ts`：后台管理接口（`/api/storages`）
- `server/src/services/__tests__/storage-multi.test.ts`：16 个新测试

前端
- `client/src/page/storage.tsx`：存储管理页面；`routes.tsx`、`admin-layout.tsx`、4 个语言文件
- `client/src/api/client.ts`：上传（含直传与回退）和存储管理 API
- `client/src/components/markdown_editor.tsx`：新增「上传文件（附件）」、视频 MIME 修正、多文件依次插入
- `client/src/components/image-upload-input.tsx`：视频上限随之放宽
- `packages/api/src/types.ts`：存储相关类型
