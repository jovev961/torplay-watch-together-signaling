# TorPlay Watch Together Signaling

A small signaling backend for TorPlay Watch Together rooms. It creates rooms, tracks membership and reconnect windows, and relays WebRTC offers, answers, and ICE candidates. Video, torrents, debrid links, filenames, credentials, source URLs, and playback media never pass through this service.

After a WebRTC DataChannel opens, playback position, play/pause/seek commands, readiness, and buffering synchronization travel directly between TorPlay peers. Redis is deliberately limited to low-frequency room lifecycle, membership, host, reconnect, expiry, and rate-limit records. SDP/ICE delivery uses local memory when both sockets share an instance and transient Redis pub/sub only when Vercel places them on different instances. There is no background Redis polling.

## Local development

Requires Node.js 22 or newer.

```sh
npm install
cp local.env.example local.env
npm run dev
```

The service starts at `http://127.0.0.1:8787` by default:

- Health: `http://127.0.0.1:8787/health`
- Signaling: `ws://127.0.0.1:8787/signal`
- Operations: `http://127.0.0.1:8787/admin`

`local.env` is ignored by Git. Use a long unique password and at least 32 random characters for the session secret. This checkout already receives generated local credentials; they are not committed.

Run verification with:

```sh
npm run check
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WATCH_TOGETHER_STORE` | `memory` locally or `redis` for Vercel. |
| `REDIS_URL` | Native TLS Redis URL used for shared state and pub/sub. |
| `WATCH_TOGETHER_ALLOWED_ORIGINS` | Comma-separated exact TorPlay browser origins. Empty permits any origin. |
| `TWTS_ADMIN_USERNAME` | Operations-page username. |
| `TWTS_ADMIN_PASSWORD` | Operations-page password. |
| `TWTS_ADMIN_SESSION_SECRET` | At least 32 random characters used to sign admin sessions. |
| `TWTS_VERCEL_DEPLOY_HOOK_URL` | Optional secret Vercel deploy-hook URL for Restart. |
| `TWTS_REDIS_PREFIX` | Optional Redis key prefix; defaults to `twts`. |
| `HOST` / `PORT` | Local listener; defaults to `127.0.0.1:8787`. |

Never prefix admin or Redis values with `NEXT_PUBLIC_`. They are server-only secrets.

## Vercel deployment

1. Import this repository into a new Vercel project.
2. Enable Fluid Compute and the WebSockets beta permission for the project.
3. Add an Upstash Redis integration or another Redis service with native TLS and pub/sub support.
4. Set `WATCH_TOGETHER_STORE=redis`, `REDIS_URL`, the three admin variables, and `WATCH_TOGETHER_ALLOWED_ORIGINS` in Vercel.
5. Create a Vercel Deploy Hook and store its URL as `TWTS_VERCEL_DEPLOY_HOOK_URL` if the dashboard Restart action should redeploy.
6. Deploy, open `/health`, then sign in at `/admin` and run **Test storage**.
7. Configure TorPlay with the deployment base URL, without `/signal`; TorPlay appends that path itself.

Vercel Hobby Functions currently end WebSocket connections after at most five minutes. TorPlay reconnects with its participant ID and reconnect token; Redis lets the new instance resume the room without persisting playback traffic.

The operations page shows aggregate counts and configuration readiness only. It never displays room codes, participant names, TMDB identities, SDP/ICE data, credentials, or environment-variable values. **Reset room state** closes all rooms. **Restart service** closes all rooms and then calls the configured deploy hook. If the hook fails, the room reset remains effective and the dashboard reports the partial failure.

## Privacy and limits

- Maximum eight participants per room.
- Six-character room codes.
- Rooms expire after 12 hours.
- Host disconnects have a 15-second reconnect grace period.
- Five room creations and twenty join attempts per IP per minute.
- Five admin login attempts per IP per 15 minutes.
- WebSocket messages are limited to 64 KiB.
- Reconnect tokens are stored only as SHA-256 hashes.
- WebSocket heartbeat frames are handled in memory and never written to Redis.
- Redis is touched for lifecycle changes and admin-requested statistics/cleanup, not on a timer.

See [docs/protocol.md](docs/protocol.md) for the complete wire contract.

## Optional Redis integration test

The regular tests use the memory adapter and need no external service. To verify a Redis deployment separately:

```sh
TEST_REDIS_URL='rediss://...' npm run test:redis
```

The test uses a unique prefix and removes its room state before disconnecting.
