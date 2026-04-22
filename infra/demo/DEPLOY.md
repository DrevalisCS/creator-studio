# Demo stack deployment

Public playground for **demo.drevalis.com**. Everything runs on the same
Hetzner VPS as drevalis.com and the license server.

## What the visitor experiences

- Opens `demo.drevalis.com` → lands in the real frontend with a sticky
  "Live demo" banner at the top.
- No sign-up, no licence activation wizard — both are bypassed by
  `DEMO_MODE=true`.
- Can click anything, edit anything. "Generate" kicks off a **scripted
  fake pipeline** that takes ~40s and copies pre-baked sample media
  into the episode folder so the review screen actually has content.
- YouTube upload returns a fake video URL — no real OAuth token exists.
- Data resets nightly at **04:00 UTC** via the `reset` container.

## Files

| Path | Purpose |
|---|---|
| `docker-compose.yml` | 5-service stack: postgres, redis, app, worker, frontend, reset. |
| `seed_demo.py` | Python seed — creates series / episodes / voices / channels. |
| `reset_demo.sh` | Wipes DB + storage, re-runs seed. Called by cron. |
| `demo_assets/` | (VPS-local) pre-baked video/thumbnail/scene images the fake pipeline copies into episode dirs. |

## Bring-up on the VPS

```bash
# 1. Clone the project onto the VPS (or rsync the infra/demo/ dir).
ssh drevalis@138.199.204.240
sudo mkdir -p /srv/drevalis-demo
sudo chown drevalis:drevalis /srv/drevalis-demo

# Copy the compose file + scripts.
scp infra/demo/{docker-compose.yml,seed_demo.py,reset_demo.sh,take_marketing_screenshots.py} \
    drevalis@138.199.204.240:/srv/drevalis-demo/
ssh drevalis@138.199.204.240 "chmod +x /srv/drevalis-demo/reset_demo.sh"

# 2. On the VPS:
cd /srv/drevalis-demo

# .env with one value — the Fernet encryption key.
# Any random Fernet key works; we don't use it to decrypt real secrets.
python3 -c "from cryptography.fernet import Fernet; print('ENCRYPTION_KEY=' + Fernet.generate_key().decode())" > .env

# 3. Drop the sample media the fake pipeline copies into each episode.
mkdir -p demo_assets
# Populate with:
#   demo_assets/video.mp4       (~15 s, 9:16, ≤ 20 MB)
#   demo_assets/thumbnail.jpg   (1080x1920)
#   demo_assets/scene_01.jpg    (1080x1920)
#   demo_assets/scene_02.jpg    ...
# Any set you're happy with showing to prospects. Nothing is rendered
# live — these are the files the "generated" episode ends up with.

# 4. Bring up the stack.
docker compose pull
docker compose up -d

# 5. First seed.
docker compose exec app python /app/seed_demo.py

# 6. Hook up Nginx Proxy Manager.
# In NPM UI, add a new proxy host:
#   Domain:   demo.drevalis.com
#   Scheme:   http
#   Forward:  frontend (port 3000) — NPM reaches it via the `proxy` net.
#   Websockets: on
#   Force SSL: on (Let's Encrypt)
```

## Verify

```bash
# On the VPS:
curl -fsS http://localhost:13000/health          # frontend nginx health
curl -fsS http://localhost:18000/health          # backend health
curl -fsS http://localhost:18000/api/v1/auth/mode  # {"team_mode":false,"demo_mode":true}

# From outside:
curl -fsS https://demo.drevalis.com/health
```

## Updating the demo

```bash
# On the VPS:
cd /srv/drevalis-demo
docker compose pull app worker frontend
docker compose up -d
docker compose exec app python /app/seed_demo.py  # reseed if schema changed
```

## Re-taking marketing screenshots

```bash
# On the VPS (needs Playwright installed in a venv).
python3 /srv/drevalis-demo/take_marketing_screenshots.py
# PNGs are written to /srv/drevalis-site/public/assets/images/ — NPM
# picks them up automatically (marketing nginx serves the static dir).
```
