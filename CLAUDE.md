# CLAUDE.md

## Git workflow

This repo (`dvgamerr-app/vision-mac`) is a solo project: **commit straight to `main` and push. Do not open pull requests or feature branches.**

## Deploy

Production is one Mac: `ssh mac-m4`, a git clone at `~/Github/vision-mac`, run by the LaunchAgent `app.dvgamerr.vision-mac`. That LaunchAgent runs `/opt/homebrew/bin/bun src/index.ts` in that directory, sets `PORT` 8090 and writes its log to `/tmp/vision-mac.log`. `~/Github` itself is a different repo (`dvgamerr-app/.github-private`): do not commit there.

"Deploy" means:

1. Commit and push to `main` (see above).
2. `ssh mac-m4 '~/Github/vision-mac/scripts/updater.sh'`. The script pulls, runs `bun install`, rebuilds the native code only when `native/` changed (set `FORCE_NATIVE=1` to force it), restarts the LaunchAgent and waits for `/health`. It stops when the clone has local edits: look at them and do not discard them blindly.
3. Confirm with a real job on the Mac, for example a `POST /tts` and then `GET /jobs/:id?wait=20000` until it says `done`. Migrations run on start; check `/tmp/vision-mac.log`.

Notes:

- The login shell on the Mac is **fish**. Send multi-line commands as `ssh mac-m4 sh -s <<'EOF' ... EOF`, not as one quoted string.
- Never push files with `git archive` or scp from this Windows checkout: `core.autocrlf=true` turns every file into CRLF. Always deploy through git.
- The service reads `~/Github/vision-mac/.env` (Bun loads it from the working directory). It is gitignored, so `git pull` never touches it.

### Settings (`.env` on the Mac)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Postgres db `vision` | needs a user with CREATEROLE the first time (pgque) |
| `TRACEWAY_URL` | `http://10.203.1.91:8082` | Traceway on the LAN; telemetry is off unless this and the token are both set |
| `TRACEWAY_TOKEN` | project ingest token | a token without the `tws_` prefix; a `tws_` token is an org setup token and is rejected |
| `PORT` | 8090 | set in the LaunchAgent plist, not in `.env` |
| optional | `WORKERS`, `NATIVE_TIMEOUT_MS`, `FILE_TTL_HOURS`, `RETENTION_HOURS`, `STUCK_MINUTES`, `AUTO_MIGRATE`, `OTEL_SERVICE_NAME` | defaults in `src/` |

- **Never read or print `.env`** on either machine. To check it, run a script with `bun --env-file ./.env check.js` that prints only `set` or `unset`.
- To add a value, append it over ssh without echoing it, for example `bun --env-file ./.env print-lines.js | ssh mac-m4 'cat >> ~/Github/vision-mac/.env'`. Then run `updater.sh` (or `launchctl kickstart -k gui/$(id -u)/app.dvgamerr.vision-mac`) so the service picks it up.
- This repo has no GitHub Actions, so Traceway needs no repo variable or secret. Its values live only in the Mac's `.env`.

### Local testing (Windows)

- The local `.env` `DATABASE_URL` points at the **live** database, and the running Mac holds its advisory lock, so a local start against it exits. Test against the compose Postgres instead, with `DATABASE_URL=postgres://vision:vision@127.0.0.1:5432/vision` set in front of the command.
- Docker runs inside WSL (`dockerman-backend`), and its TCP bridge on Windows can be down. In that case start Postgres with `cat compose.yaml | wsl.exe -d dockerman-backend -- docker compose -p vision-mac -f - up -d --wait` (and `down` afterwards).
- Off macOS every processing job ends `failed`. Routes, the queue, migrations and Traceway spans still work.
