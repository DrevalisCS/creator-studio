# Restore — "I see rows but videos don't play"

After you restore a backup and manually copy the `storage/` folder into
your new install, the DB has `media_assets` rows but the UI can't find
the files. Three common causes, diagnosed below.

## Quickest check — run the diagnostic

```bash
docker compose cp scripts/diagnose_media.py app:/app/scripts/diagnose_media.py
docker compose exec app python /app/scripts/diagnose_media.py
```

The script walks every `media_assets` row, resolves `storage_base_path
+ file_path`, and tells you how many files are missing grouped by
asset type. It prints the first few missing paths so you can spot the
pattern instantly.

## Cause 1 — path prefix mismatch

`file_path` in the DB is **relative to `storage/`**, not absolute.
A correct value looks like `episodes/<uuid>/output/final.mp4`. If
you copied the folder as `./storage/storage/episodes/...` (one level
too deep) the app resolves `storage/episodes/<uuid>/…` → missing.

**Fix:** move the files up one level so you have
`/your-data-dir/storage/episodes/<uuid>/…`, not
`/your-data-dir/storage/storage/episodes/...`.

## Cause 2 — container can't read the files

`docker-compose.yml` mounts `./storage` into `/app/storage`. The
container process runs as uid `1000`. If you rsync'd the files with
sudo, the files are owned by root and unreadable.

**Fix on the host:**

```bash
sudo chown -R 1000:1000 /path/to/your/storage
```

You'll see `ls: can't open ... Permission denied` in
`docker compose logs app` when this is the problem.

## Cause 3 — video rows exist but file isn't there

Not every episode in the backup had a final video — only those that
actually reached the `exported` state. `media_assets` rows of
`asset_type='video'` where the file is missing are fine for episodes
still in `review` or `editing`.

**Fix:** Reassemble the affected episode:

```
Episode detail → Reassemble
```

That re-runs captions + assembly + thumbnail from the kept voice +
scenes assets and writes a fresh `final.mp4`.

## Cause 4 — frontend `<video>` won't play the blob

If the static nginx proxy strips `Accept-Ranges` or mis-sets
`Content-Type`, browsers refuse to seek. Check your response headers:

```bash
curl -I http://localhost:8000/storage/episodes/<uuid>/output/final.mp4
# expect: content-type: video/mp4 + accept-ranges: bytes
```

The built-in FastAPI `StaticFiles` does both automatically. If you
front it with your own nginx and it's stripping, add
`add_header Accept-Ranges bytes;` and make sure the `types` block
maps `.mp4` to `video/mp4`.

---

If `diagnose_media.py` reports 100% present but the UI still can't
play, it's almost always (4). Paste the `curl -I` output into a
support ticket and we'll pinpoint.
