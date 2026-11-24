# Restarting DuelSeries

DuelSeries was shut down on **2026-11-24**. All the money was moved out, and every AWS part that bills was deleted.
The code, the database and the keys are all kept, so bringing it back is about **2 to 3 hours** of setup.
Most of that time is waiting for installs and DNS.

**Before Apr 8 2027:** if you might restart, renew **duelseries.com** at GoDaddy. Auto-renew is off, and once the
domain lapses someone else can buy it.

## What was kept, and where

| What | Where |
|---|---|
| Code | This GitHub repo, `DuelSeries/duelseries.com` (archived, so it is read only until you unarchive it) |
| Database dump (Postgres custom format, `pg_restore`) | `DuelSeries backup 2026-11-24/duelseries_db.dump` |
| Server `.env` (all secrets) | `DuelSeries backup 2026-11-24/server files/.env` |
| `server/data` (Bot bank key, owner sessions, money journals) | `DuelSeries backup 2026-11-24/server-data.tgz` |
| nginx config (open, before the closed page) | `DuelSeries backup 2026-11-24/nginx.tgz` |
| Box scripts (deploy, rehearse, nginx switch) | `DuelSeries backup 2026-11-24/box-extras.tgz` |
| Escrow and Bot bank keys in Phantom format | `DuelSeries backup 2026-11-24/PHANTOM KEY - *.txt` |
| Checksums | `DuelSeries backup 2026-11-24/SHA256SUMS` (`sha256sum -c SHA256SUMS`) |

The backup folder is on the PC (`Documents`) and offsite in OneDrive (`OneDrive\Documents`). It holds every secret,
so never put it in the repo.

Still running on free plans: the **Privy** app (login and wallets, same app id), **PostHog** (analytics) and the
**Helius** RPC key (in `RPC_URL`). Deleted: both EC2 servers and their disks, the Elastic IP, the clips S3 bucket,
CloudFront, the clips IAM user, and the DNS records.

## Steps

1. **GitHub:** open the repo, go to **Settings**, then **Danger Zone**, and click **Unarchive**.
2. **AWS server (ca-central-1):** launch a **t3.micro** EC2 on Ubuntu 26.04 LTS (or the newest LTS) with a 20 GB gp3
   disk, the same as before. Make a new key pair and save its `.pem`. Security group: 22 from your IP, 80 and 443 from
   anywhere. Allocate an **Elastic IP** and attach it.
3. **DNS (GoDaddy):** add `A @` and `A www`, both pointing at the new Elastic IP. Skip `eu` unless EU comes back too.
4. **Box packages** (SSH in as `ubuntu`):
   ```bash
   sudo apt update && sudo apt install -y nginx postgresql git certbot python3-certbot-nginx
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
   sudo npm i -g pm2
   ```
5. **Code:**
   ```bash
   git clone https://github.com/DuelSeries/duelseries.com.git ~/duelseries
   cd ~/duelseries && npm install --production
   ```
   (`public/wallet/widget.js` is committed, so no build is needed.)
6. **Database:** copy `duelseries_db.dump` up with scp, then:
   ```bash
   sudo -u postgres psql -c "CREATE USER duelseries WITH PASSWORD 'pick-one';"
   sudo -u postgres createdb -O duelseries duelseries_db
   pg_restore --no-owner --role=duelseries -d "postgres://duelseries:pick-one@localhost:5432/duelseries_db" duelseries_db.dump
   ```
7. **Secrets and data:** copy `server files/.env` to `~/duelseries/.env` and set `DATABASE_URL` to the password from
   step 6. Delete the six `CLIPS_*` lines, because that bucket is gone and sharing clips stays off without them.
   Copy `server-data.tgz` up and run `tar -xzf server-data.tgz -C ~/duelseries`. Check that
   `server/data/maintenance.json` says `"on": false` once you want players back.
8. **nginx and HTTPS:** run `sudo tar -xzf nginx.tgz -C /`. That restores `sites-available/duelseries`, which
   points at `/etc/letsencrypt`. Then:
   ```bash
   sudo ln -sf /etc/nginx/sites-available/duelseries /etc/nginx/sites-enabled/duelseries
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo certbot certonly --nginx -d duelseries.com -d www.duelseries.com   # once DNS from step 3 has spread
   sudo nginx -t && sudo systemctl reload nginx
   ```
   If `nginx -t` fails before the certificate exists, comment out the 443 server block, run certbot, then put the
   block back.
9. **Start it:**
   ```bash
   cd ~/duelseries && pm2 start server/index.js --name duelseries && pm2 save && pm2 startup
   curl -s localhost:3000/healthz
   ```
10. **Auto-deploy:** in the repo's **Settings**, then **Secrets**, set `EC2_HOST` to the new Elastic IP, `EC2_KEY` to the
    new `.pem` and `EC2_USER` to `ubuntu`. Then turn the workflows back on:
    `gh workflow enable "Deploy to AWS" && gh workflow enable "Uptime check"`.
11. **Money wallets:** the Escrow (`ESCROW_PUBLIC_KEY` in `.env`) and the Bot bank (`server/data/bot-bank-key.json`)
    are the same wallets as before, now empty. Send the Escrow about 0.05 SOL for network fees, and fund the Bot
    bank if you want paid bots.
12. **Test before telling anyone:** open `/owner` and sign in, play a free game, then do one small paid stake and cash
    it out.

EU (`eu.duelseries.com`) is optional. Repeat steps 2 to 9 in eu-west-1 with `REGION=eu`, then follow the EU notes in
`.github/workflows/deploy.yml`.

## Before the shutdown

- NA server: `i-04a9cebdacc40159d`, ca-central-1, t3.micro, 20 GB disk (6.5 GB used), Elastic IP 16.54.23.244,
  Ubuntu 26.04, Node 20.20, PostgreSQL 18 (the dump needs `pg_restore` 18 or newer), nginx 1.28.
- EU server: `i-0467b27b98c9aaa99`, eu-west-1, t3.micro (stopped since summer).
