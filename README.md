# Weight Bot

A Discord bot for tracking offender Weight and role permissions.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in your bot token, client ID, and guild ID.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a persistent database folder (outside the repo):
   ```bash
   sudo mkdir -p /var/lib/weight-bot
   sudo chown -R $(whoami) /var/lib/weight-bot
   ```
5. Copy any existing DB into the persistent location:
   ```bash
   cp ./data/weight.db /var/lib/weight-bot/weight.db
   ```
6. Start with PM2:
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup systemd
   ```
7. Follow the command printed by `pm2 startup`.
8. Confirm the bot is running:
   ```bash
   pm2 status
   ```

## Recommended git setup

1. Initialize git:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
2. Add your remote:
   ```bash
   git remote add origin https://github.com/youruser/yourrepo.git
   git branch -M main
   git push -u origin main
   ```

## Update checklist

When updating code, do this:

1. Backup the DB:
   ```bash
   cp /var/lib/weight-bot/weight.db /var/lib/weight-bot/weight.db.bak
   ```
2. Pull the latest code:
   ```bash
   git pull origin main
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Restart the bot with PM2:
   ```bash
   pm2 restart weight-bot
   pm2 save
   ```
5. Confirm the process:
   ```bash
   pm2 status
   ```

## Restart checklist

If the bot needs a restart:

1. Ensure the DB path is persistent and not in the repo.
2. Restart using PM2:
   ```bash
   pm2 restart weight-bot
   pm2 save
   ```
3. Check logs if something fails:
   ```bash
   pm2 logs weight-bot --lines 100
   ```

## Important notes

- Do not commit `.env` or any secret values.
- Do not commit `data/*.db`.
- Keep the database file at `/var/lib/weight-bot/weight.db` or another external persistent path.
- If you change `ecosystem.config.js`, restart PM2 and save the process list.
