# Disaster Recovery: the account is gone, the blog is not

This guide covers one scenario: **your whole Cloudflare account is lost (or you deleted the Worker / D1 database by accident) and you want to bring the blog back, byte for byte, with a brand-new account plus the original storage bucket.**

> Short version: if the bucket still exists, contains a backup file, and still holds your images/videos, all content comes back 100%.
> The only things that cannot come back are the environment variables (secrets, domain, OAuth app) — recreate those in the new account.

---

## 1. What is inside a backup

Each backup is a single JSON file written by `POST /api/backup/export-to-storage` into the bucket's `backups/` folder, keeping the 3 newest files.

| Data | In backup | Notes |
| --- | --- | --- |
| Posts, moments, friends, comments, tags | ✅ | All content |
| Site config (name, theme, comment switches, announcement…) | ✅ | Site looks the same after restore |
| Users (site owner, GitHub `openid`, password hash) | ✅ | PBKDF2 hashes are portable, password login keeps working |
| Custom storage config + file index | ✅ | The index is backed up; **the files themselves never left the bucket** |
| Visit stats and details (`visit_stats` / `visits`) | ✅ | IPs are stored hashed; only the latest 20k detail rows are included, PV/UV totals are complete |
| Environment variables (`JWT_SECRET`, `S3_*`, `RIN_GITHUB_CLIENT_*`, domain) | ❌ | Not data — reconfigure in the new account |
| SecretKey of custom storages, GitHub backup token | ⚠️ | Backed up but encrypted with the old master key; re-enter after switching accounts |

Since v0.3.0 the Worker's cron trigger writes a snapshot every day (`backups/rin-backup-*.json`), so the bucket always holds a backup less than 24 hours old. To change that interval, set `backup_auto_interval_hours` in `server.config` (`0` disables it).

---

## 2. Before disaster strikes

1. In the dashboard go to Settings → Backup and click **Export to cloud storage** once; make sure `backups/rin-backup-*.json` shows up.
2. Write down (a password manager is fine):
   - the bucket's `endpoint` / `bucket` / `AccessKey` / `SecretKey`;
   - the site's `JWT_SECRET` and `S3_FOLDER`;
   - whether you log in with a password or GitHub OAuth.
3. If you use custom storages configured in the dashboard (R2/S3/WebDAV), also pin `STORAGE_SECRET`. With a fixed value, the old encrypted secrets still decrypt after switching accounts, so you can skip re-entering them.

## 3. Recovery steps

### Step 1: rebuild the Worker in the new account

1. Fork the repo in the **new account** and follow the [deploy guide](/en/guide/deploy) to create a D1 database and an R2 bucket (or keep using external S3/WebDAV).
2. Set the environment variables. **Three are critical**:
   - `JWT_SECRET`: a new value is fine, but custom storage secrets / GitHub tokens will need to be re-entered;
   - `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`: pointing at **the original bucket**;
   - `S3_FOLDER`: must match the previous value exactly (e.g. `images/`), otherwise media paths break.
3. Open the site and log in with the initial admin account.

> If your media lives in a different custom storage, re-add it under Settings → Storage first (same endpoint/bucket/AccessKey, re-enter the SecretKey — its config is also in the backup).

### Step 2: restore from the bucket

Dashboard → Settings → Backup → **Restore from cloud storage**, paste the backup path (e.g. `backups/rin-backup-2026-01-01T10-00-00.json`) and confirm.

What the restore does:

1. Validates the backup structure first — **a bad file aborts before a single row is touched**;
2. Copies the current database to `backups/pre-restore.json` in the bucket (so you can roll back);
3. Clears and rewrites every content table (posts, comments, friends, config, storages, visit data);
4. **Keeps your current login as admin** — even if the backup's owner is a different GitHub account, you stay an administrator;
5. Clears server caches and reports the real row counts read back from the database.

When it finishes you get a report: post/comment/moment/friend/file counts, the location of `pre-restore.json`, and anything that still needs manual work (e.g. "the SecretKey of storage X cannot be decrypted, please re-enter it").

### Step 3: post-restore checklist

| Check | Expected |
| --- | --- |
| Home page, pagination, tags | Same as before |
| Site name/icon/theme | Same as before (`site.*` config restored) |
| Images inside posts | Render fine (index restored, files still in the bucket) |
| Settings → Storage | Re-enter SecretKey if a "cannot decrypt" warning appeared |
| Visit stats | Historical PV restored, new visits keep counting |
| Comments / friends / moments | All present |
| GitHub backup (if used) | Re-enter the token once |
| `RIN_GITHUB_CLIENT_ID/SECRET` | Recreate the OAuth app in the new account; callback URL unchanged |

---

## 4. FAQ

**Q: The new account's `storages` table is empty — can I still restore?**
Yes. The restore entry point tries, in order: the environment-variable default storage → usable custom storages in the database → any other storage whose secret still decrypts. As long as `S3_*` points at the bucket, restore works even with zero storage rows.

**Q: It says a storage secret cannot be decrypted. What now?**
`STORAGE_SECRET` (or `JWT_SECRET` when unset) changed. Either set `STORAGE_SECRET` to its previous value, or re-enter that storage's SecretKey in Settings → Storage. Meanwhile the default (env) storage keeps working, so media does not break.

**Q: Will restore overwrite what I just created in the new account?**
Yes, so a `backups/pre-restore.json` snapshot is written first; restore that file later if you need it back.

**Q: What if there is no backup file?**
Then only a GitHub backup (if configured) or a locally exported JSON can help. **Backups must exist before the disaster** — which is why automatic daily backups are on by default.

**Q: Why are fewer `visits` rows present than before?**
Two expected reasons: visits recorded after the snapshot is gone, and the snapshot keeps only the latest 20k detail rows (busy sites have millions, which would bloat the JSON and slow restores). PV/UV totals are always complete, and the restore report tells you how many rows were skipped.

---

## 5. Verifying the flow (developers)

```bash
cd server
bun test src/services/__tests__/backup-disaster-recovery.test.ts
```

The test drives the whole scenario against real SQLite plus a fake object store: an old instance exports a backup → a new instance (empty `storages`, only the admin user) restores from the bucket → assertions cover content, config, file index, visit data, the pre-restore snapshot, admin identity, undecryptable-secret fallback, and "bad file touches nothing".
