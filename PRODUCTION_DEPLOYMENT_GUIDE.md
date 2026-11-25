# Clip Network — Production Deployment Guide

**Status**: `SANDBOX VERIFIED` (Production Docker Compose with PostgreSQL 16, Redis 7, MinIO S3, API, and Web ready; staging/prod cutover awaits operator secrets & domain)

## Quick start on a single VPS (Ubuntu, 4 vCPU / 16 GB recommended)

Everything runs on one domain: Caddy on the host terminates HTTPS and forwards `/clip-network-media/*`
(stored clips) to MinIO and everything else to nginx, which serves the web app and the API under `/api`.

1. **DNS.** Create an `A` record for your app domain (for example `app.example.com`) pointing at the
   VPS's IPv4 address. Wait until `dig +short app.example.com` returns that address.
2. **Code on the server.** Push this repository to GitHub, then on the VPS:
   ```sh
   git clone https://github.com/Stark-Industries-create/Clip_Network.git /opt/clip-network
   cd /opt/clip-network
   ```
3. **Set up and start** (installs Docker, Caddy and the firewall, generates secrets into
   `.env.production`, gets the HTTPS certificate, builds and starts the stack, schedules nightly
   database backups):
   ```sh
   sudo bash deploy/setup-vps.sh app.example.com you@example.com
   ```
   Back up `.env.production` somewhere safe. Losing `ENCRYPTION_MASTER_KEY` makes saved integration
   keys and connected social accounts unreadable.
4. **Admin account.** Register at `https://app.example.com/register`, then:
   ```sh
   docker compose -f docker-compose.prod.yml --env-file .env.production exec api node apps/api/dist/provision-admin.js you@example.com
   ```
5. **Integrations.** In the app, open Control Center > Integrations and add Stripe (then "Test key and
   create plan prices" and "Create webhook"), Resend, and each platform's OAuth keys. Register
   `https://app.example.com/social-accounts` and `https://app.example.com/auth/google` as redirect URIs.
6. **Updates.** `sudo bash deploy/deploy.sh` backs up the database, pulls, rebuilds and restarts.
   Migrations run when the API starts.

### Automatic deploys (GitHub Actions)

Every push to `main` runs **CI** (`.github/workflows/ci.yml`): typecheck, tests, production builds, a
gitleaks scan of the full history, and Docker builds of the api, worker and web images. When CI passes
on `main`, **Deploy** (`.github/workflows/deploy.yml`) SSHes to the VPS, fast-forwards to exactly the
tested commit and runs `deploy/deploy.sh` (database backup, rebuild, restart, health check).

One-time setup:
1. On your computer, create a deploy key: `ssh-keygen -t ed25519 -f clipnetwork_deploy -N ""`.
2. On the VPS, authorize it: append `clipnetwork_deploy.pub` to `/root/.ssh/authorized_keys`.
3. In GitHub, Settings > Secrets and variables > Actions, add secrets:
   - `VPS_HOST`: the server IP
   - `VPS_SSH_KEY`: the contents of the private key file `clipnetwork_deploy`
   - `VPS_KNOWN_HOSTS`: the output of `ssh-keyscan -t ed25519 <server IP>`
   and the variable `APP_URL` (for example `https://app.example.com`) for the post-deploy check.
4. Optional: Settings > Environments > `production` > Required reviewers, to approve each deploy.

Until the secrets exist, Deploy reports "not configured" and does nothing. Run it by hand from the
Actions tab with "Run workflow".

The API trusts exactly two proxies (`TRUST_PROXY_HOPS=2`: Caddy, then nginx) so sign-in rate limits
apply per visitor. Change it if you add or remove a proxy in front of the API.

## Production Stack (`docker-compose.prod.yml`)
- **Database**: PostgreSQL 16 (`postgres:16-alpine`) with persistent named volume `postgres_data` and `pg_isready` healthcheck.
- **Cache / Queue**: Redis 7 (`redis:7-alpine`) with AOF persistence and `redis-cli ping` healthcheck.
- **Object Storage**: MinIO (`minio/minio`) or managed AWS S3 / Cloudflare R2 via `S3_*` env vars.
- **API**: Multi-stage non-root `Dockerfile.api` on port `4100` with `/api/health` readiness probe.
- **Web**: Multi-stage non-root `Dockerfile.web` on port `3100` depending on healthy API.

## Environment Cutover Steps
1. Copy `.env.example` to `.env.production` on the deployment host and load production secrets there. Use a Stripe live secret key, the signing secret for the live webhook endpoint, and live price IDs for all paid plans. Configure Resend with a verified sender, S3 credentials, and at least one publishing provider. Use either `POSTIZ_API_KEY` with connected destinations or production OAuth credentials for a direct social provider.
2. Point `S3_ENDPOINT` to an HTTPS origin reachable by the API, browsers, and the publishing provider. Create the private bucket and allow the application origin to perform signed PUT and GET requests. Configure the TLS edge on the host to forward web and API traffic to `127.0.0.1:8080`.
   - A fresh PostgreSQL database gets the checked-in baseline automatically during API startup. For an existing database, back up and verify it matches the baseline before using `prisma migrate resolve --applied 20261123000000_baseline --schema=prisma/schema.postgresql.prisma`.
   - Review existing `SUPER_ADMIN` accounts and revoke roles and sessions for any account whose ownership you cannot establish.
3. Launch stack: `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`.
4. Place TLS-terminating reverse proxy (Nginx / Caddy / Cloudflare) in front of `:3100` (app) and `:4100` (API).

## Rollback Strategy
- Tag every production Docker image by Git SHA (`clip-network-api:<sha>`, `clip-network-web:<sha>`).
- Use additive-only Prisma migrations; before applying schema changes, run `pg_dump` snapshot to object storage.
- On regression, re-pin Compose image tags to the previous SHA and run `docker compose up -d`.


## Provision a platform admin

Have the operator register and verify their account. From the deployment host, run:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production exec api node apps/api/dist/provision-admin.js verified-operator@example.com
```

## Render and review clips

Manual clip creation accepts an MP4 in Review Studio. The optional source worker processes detected YouTube entries when an authorized recording connector supplies source bundles. Set `SOURCE_AUTOMATION_ENABLED=true` on the worker after applying migrations.

The production Compose worker builds the `inference` target with yt-dlp, Whisper, FFmpeg, OpenCV, and both model files. Model checksums are verified at build time. The API runs a smaller image.

Set `SOURCE_AUTOMATION_ENABLED=true` on the worker. Tag a creator's YouTube, Twitch or Kick channel URL in the website, and set the creator's spoken language. The worker lists each channel's recordings on every poll, tracks live broadcasts until their recordings are available, and catches up on recordings missed during downtime. Analyze only channels whose owners authorized it.

Analysis never downloads a whole video. For YouTube it reads the platform's caption track, downloads audio only for loud moments, pauses and speaker labels, picks moments over the full recording, and runs whisper only on about 20 seconds around each chosen moment. Twitch and Kick have no captions, so their audio is transcribed in resumable two-minute windows. Rendering then downloads only the clip's own section. Each recording's measured cost (transcript source, wall time, whisper seconds, audio size) is stored with it for pricing.

Two optional providers make analysis faster and the picks better. Both use OpenAI-compatible APIs, so the provider is a URL, model and key:

- Hosted transcription (`TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_MODEL`, for example Groq `whisper-large-v3-turbo`) transcribes Twitch and Kick audio in ten-minute uploads instead of hours of worker CPU, and handles the short exact-edge passes. Local whisper remains the fallback. YouTube recordings without captions wait up to 45 minutes for YouTube's own captions before any paid transcription.
- LLM ranking (`HIGHLIGHT_LLM_URL`, `HIGHLIGHT_LLM_API_KEY`, `HIGHLIGHT_LLM_MODEL`) sends numbered transcript lines, with loud-moment and most-replayed markers and the creator's topic rules, to a chat model. The model answers with line ranges, never timestamps, which the worker converts to exact times and trims to whole sentences. The built-in rules still enforce compliance, length, overlap and the one-clip-per-ten-minutes ceiling, and take over if the model fails. Transcripts leave your infrastructure, so name the provider in your terms.

A public recording is analyzed once, however many workspaces track it. The shared analysis uses no workspace's rules and keeps three candidates per clip slot; each workspace then picks from that pool under its own compliance rules and campaign topics, in memory, with a rule-based scan of the shared transcript as a fallback. A database row (`RecordingAnalysis`) records the shared result and locks it while one worker analyzes, and the transcript lives under `shared/recordings/` in storage. Every workspace is still charged the recorded hours it uses; its stored cost shows `cacheHit` when the analysis was reused.

Post engagement is read from each destination platform 24 and 72 hours after publishing, and when someone opens Analytics (posts checked in the last six hours are not fetched again). Real posts only ever show platform numbers. Instagram and TikTok analytics need the insights and video-list permissions now requested at connection time; accounts connected earlier show "Reconnect this account once to allow analytics." Posts sent through Postiz show no engagement numbers yet.

Each recording's stored cost records which path ran (`transcriptSource`, `rankedBy`), local and hosted transcription seconds, and LLM tokens.

The worker runs `WORKER_CONCURRENCY` task slots (default 2) and can be scaled out by running more worker processes against the same database; every task claims its row atomically. Workspaces take turns (least recently served first), and each plan sets how many jobs a workspace may run at once, its longest recording, and its recorded hours per month. Recordings over a limit are skipped with the reason shown beside them.

Split-screen uses a creator's saved crop when present. Otherwise the worker samples the clip and uses a facecam crop only when it finds a stable location. If detection is uncertain, the renderer preserves the full scene. The worker transcribes the rendered audio for final captions. Review Studio retries for automated clips queue on the same worker. A worker outside Compose can set `CLIP_FINAL_CAPTION_MODEL` and `FACECAM_YUNET_MODEL` to local models. Set both `YOUTUBE_WHISPER_CLI` and `YOUTUBE_WHISPER_VAD_MODEL` to use whisper-cli with voice activity detection, or use an FFmpeg build with the Whisper filter.

An authorized connector can register source metadata at `POST /api/v1/monitor/videos` using workspace admin authorization. Supply `creatorId`, `externalVideoId`, `title`, `videoUrl`, and ISO `publishedAt`. Use the original platform video ID so connector retries and YouTube feed polling share the same record.

An authenticated workspace admin can list detected videos at `GET /api/v1/monitor/videos` and request signed PUT URLs at `POST /api/v1/monitor/videos/:videoId/source-upload`. Upload the matching MP4 first, then the timestamped JSON transcript. Use a creator-authorized export or recording connector. The JSON shape is `{ "durationSec": 60, "cues": [{ "startSec": 0, "endSec": 2, "text": "First spoken phrase." }] }`. Cues are chronological and non-overlapping. Source MP4s are limited to 250 MiB and transcript JSON to 1 MiB.

For unattended posting, a workspace admin turns on automatic publishing (`PATCH /api/v1/workspace/automation` with `{ "autoPublishEnabled": true }`), and each destination account must also allow it. Verify provider requirements first. Without that opt-in, rendered clips wait for review. `AUTO_PUBLISH_DISABLED=true` on the worker stops automatic posting for every workspace. Keep signed URLs private and configure lifecycle rules for source and rendered objects.

Use the Postiz pilot with Instagram Reels or X, or set `POSTIZ_YOUTUBE_MADE_FOR_KIDS` for unlisted YouTube Shorts. TikTok live publishing requires a separate destination settings and consent flow.

### Managed connector enrollment

Set `SOURCE_CONNECTOR_WORKSPACE_ID` to the pilot workspace. Configure the worker with the connector's HTTPS `SOURCE_CONNECTOR_SUBSCRIPTIONS_URL` and `SOURCE_CONNECTOR_ADMIN_TOKEN`. With source automation enabled, the worker sends a bearer-authenticated PUT on startup and each monitor tick. The JSON body is `{ "workspaceId": "...", "subscriptions": [{ "creatorId": "...", "platform": "TWITCH", "handle": "...", "channelUrl": "https://www.twitch.tv/..." }] }`. The connector must treat this as a complete replacement for that workspace. An empty list clears subscriptions. Repeated snapshots must be safe. Use only tagged sources with creator-authorized recording access.

Configure the connector with the Clip Network API origin and a separate `SOURCE_CONNECTOR_INGRESS_TOKEN`, also set on the API. Send it as `X-Source-Connector-Token` on source registration and source-upload requests. This token can access only those two endpoints for monitored creators in the configured workspace. Use the same external video ID for retries. The connector must deliver the matching MP4 and timestamped transcript automatically. Configure the connector operator's recording permissions and caption export before enabling auto-publish.

### Connect Instagram

Use a dedicated Postiz organization for the pilot. Set `POSTIZ_API_KEY`, `POSTIZ_INSTAGRAM_WORKSPACE_ID`, a valid 64-hex-character `ENCRYPTION_MASTER_KEY`, and `PUBLIC_APP_URL` to the browser origin. Set `POSTIZ_FRONTEND_URL` if self-hosting. Enable Instagram Standalone in Postiz.

In **Social Accounts**, select **Connect Instagram**. The user approves access using their Instagram professional account. Clip Network checks the provider's integration list before saving a destination. Wait for the one-hour link to expire before opening another authorization. Keep all Instagram linking activity in the dedicated organization on this flow while a connection is pending. Auto-publish stays off until explicitly enabled.

### Direct social connections and publishing

Create provider apps and register `PUBLIC_APP_URL/social-accounts` as the exact OAuth redirect URI. Set the matching `*_CLIENT_ID` and `*_CLIENT_SECRET` on the API and worker. TikTok's client ID is its client key. Use HTTPS for Meta and TikTok callbacks. Set a supported `META_GRAPH_VERSION` and a valid `ENCRYPTION_MASTER_KEY`. Apply the direct social migration before starting the API and worker.

- Facebook uses Page permissions and posts public Reels. Select a Page that grants content-creation access.
- Instagram uses Instagram Login for professional accounts and publishes Reels through Meta's container workflow.
- YouTube uses YouTube Data API and resumable uploads. Set `YOUTUBE_MADE_FOR_KIDS` to the correct audience for this deployment. Uploads request unlisted visibility.
- TikTok uses Login Kit and the Content Posting upload scope. Verify the media URL prefix in TikTok before using URL pull. Users explicitly send a draft from the publishing queue and finish in their TikTok inbox.

Provider reviews and app permissions apply before public onboarding. Existing Postiz-linked destinations can continue to use their existing adapter. New Facebook, Instagram, YouTube, and TikTok connections from Social Accounts use direct OAuth.

For a live test with the local Docker Compose file, supply S3 settings and set `LOCAL_RECONCILE_INTERVAL_MS=30000` so the API checks submitted posts. The production worker handles these checks in staging and production.

### Startup and health checks

Production API and worker startup reject malformed PostgreSQL, S3, encryption, and enabled-provider settings. Configure public HTTPS origins for the application and S3. The API requires Resend credentials for signup and recovery. Production checkout requires Stripe, and the sandbox billing webhook is disabled in production. Configure an API connector ingress token of at least 32 characters and pass a monitor interval of at least 30 seconds to the worker.

Use `/api/livez` for process liveness and `/api/readyz` for database and migration readiness. The worker Docker health check uses a timestamp written after a successful polling cycle. Alert on unhealthy worker status and persistent provider failures. Shutdown stops new polls and lets the current workspace job finish before disconnecting.
