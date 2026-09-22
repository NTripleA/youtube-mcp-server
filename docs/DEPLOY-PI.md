# Raspberry Pi deployment

A single MCP connector exposing public read tools, channel analytics, and
channel-locked write tools, reachable by Claude and ChatGPT over a Cloudflare
Tunnel.

```
Claude / ChatGPT
      |  HTTPS
Cloudflare Access (Managed OAuth + user allow policy)
      |  Protect-with-Access on the tunnel route (JWT validated)
cloudflared on the Pi
      |  http://127.0.0.1:8003
Docker published port  127.0.0.1:8003 -> container:8000
      |
youtube-mcp  (non-root uid 10001)
      |
/state/token.json (0600)     /media (read-only)
```

Two things bound what this deployment can do, independently of each other:

1. **Cloudflare Access** decides who may reach `/mcp` at all.
2. **The channel lock** decides what a request that gets through may change -
   every write verifies the target belongs to `YOUTUBE_ALLOWED_CHANNEL_ID`
   before mutating anything.

The container port is published to `127.0.0.1` only, so nothing on the LAN can
reach the server directly even if Cloudflare is misconfigured.

---

## 1. One-time OAuth provisioning (on your Mac)

Do this on the machine that holds the OAuth client secret. **Never run the
authorization flow on the Pi** - the remote server has no authorization-code
handling at all, by design.

### 1.1 Create a Desktop-app OAuth client

Google Cloud Console → **APIs & Services** → **Credentials** →
**Create credentials** → **OAuth client ID** → Application type **Desktop app**.

Enable both **YouTube Data API v3** and **YouTube Analytics API** for the
project.

### 1.2 Settle the publishing status — this one bites a week later

**APIs & Services → OAuth consent screen.** If the app is **External** and in
**Testing**, Google issues refresh tokens that **expire after seven days**. The
deployment will work perfectly, then silently stop about a week after you set it
up.

Pick one deliberately:

- **Publish the app** ("In production"). An unverified app using these scopes
  still works for its own owner; you get a warning screen during consent that
  you click through. Refresh tokens then do not expire on a timer.
- Or accept the 7-day cadence and plan to re-run `npm run auth` weekly.

Check this now, not after the first outage.

### 1.3 Authorize

```bash
cd ~/path/to/youtube-mcp-server
npm ci

cat > .env <<'EOF'
YOUTUBE_API_KEY=<your api key>
YOUTUBE_CLIENT_ID=<client id>.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=<client secret>
EOF

npm run auth
```

This opens a browser, receives the redirect on a temporary `127.0.0.1` listener
(PKCE, `access_type=offline`), and writes the token to:

```
~/.config/youtube-mcp/token.json
```

It prints the **granted** scopes (read back from the token, not the ones
requested) and your channel ID. Note that channel ID - it is what
`YOUTUBE_ALLOWED_CHANNEL_ID` must be set to.

### 1.4 Verify analytics access (optional but recommended)

```bash
npm run verify:analytics
```

Read-only. Runs one real Analytics query and confirms the grant actually permits
it, which the token's scope string alone cannot prove.

---

## 2. Prepare the Pi

```bash
# Directories. The state dir MUST be owned by the container's runtime uid:
# a chown inside the image does not apply to a bind mount.
sudo install -d -o 10001 -g 10001 -m 700 /opt/mcp/youtube/state
sudo install -d -o 10001 -g 10001 -m 755 /opt/mcp/youtube/media

# The env file holds the client secret: root-owned, not world-readable.
sudo install -m 600 -o root -g root /dev/null /opt/mcp/youtube/youtube-mcp.env
```

Never use `chmod 777` on any of these.

### 2.1 Copy the credentials over

From your Mac:

```bash
scp ~/.config/youtube-mcp/token.json pi@raspberrypi:/tmp/token.json
```

On the Pi:

```bash
sudo install -m 600 -o 10001 -g 10001 /tmp/token.json /opt/mcp/youtube/state/token.json
rm /tmp/token.json
```

### 2.2 Write the env file

```bash
sudo tee /opt/mcp/youtube/youtube-mcp.env >/dev/null <<'EOF'
YOUTUBE_API_KEY=<your api key>
YOUTUBE_CLIENT_ID=<client id>.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=<client secret>

# The only channel this deployment may modify.
YOUTUBE_ALLOWED_CHANNEL_ID=<UC... from `npm run auth`>

# The write switch. Start with false, confirm reads work, then enable.
YOUTUBE_ENABLE_WRITES=false

# Host header allowlist. Two entries are required here:
#   1. The public hostname - cloudflared forwards the original Host by default.
#      (If your tunnel ingress sets httpHostHeader, use THAT value instead.)
#   2. The loopback form of the PUBLISHED port. The container binds 8000 and
#      Docker publishes it as 127.0.0.1:8003, so a local curl sends
#      "Host: 127.0.0.1:8003" - a value the container cannot infer for itself.
#      Without it, every local diagnostic below returns 403.
MCP_ALLOWED_HOSTS=youtube.example.com,127.0.0.1:8003,localhost:8003
EOF

sudo chmod 600 /opt/mcp/youtube/youtube-mcp.env
```

`YOUTUBE_TOKEN_FILE`, `YOUTUBE_MEDIA_DIR`, `MCP_TRANSPORT`, `MCP_HTTP_HOST` and
`MCP_HTTP_PORT` are already set correctly by the image; do not repeat them here.

---

## 3. Build and run

```bash
cd /opt/mcp/youtube/youtube-mcp-server    # wherever you cloned it
docker compose up -d --build youtube-mcp
```

Check it:

```bash
docker compose ps
docker compose logs --tail=50 youtube-mcp
curl -s http://127.0.0.1:8003/healthz          # {"status":"ok"}
```

The startup log states plainly whether writes are enabled and whether the
channel lock verified.

### Confirm the port is not on the LAN

```bash
ss -tlnp | grep 8003     # must show 127.0.0.1:8003, never 0.0.0.0:8003
```

### Smoke-test MCP

```bash
curl -s http://127.0.0.1:8003/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"curl","version":"1.0"}}}'

curl -s http://127.0.0.1:8003/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

With `YOUTUBE_ENABLE_WRITES=false` the write tools will not appear, and calling
one by name returns a refusal naming the variable.

---

## 4. The write switch

**`docker restart` does not reload `env_file`.** Docker bakes the environment
into the container at creation; a restart reuses it. The container must be
recreated.

```bash
# Emergency stop - cuts off all access immediately
docker compose stop youtube-mcp

# Change the switch
sudo nano /opt/mcp/youtube/youtube-mcp.env      # YOUTUBE_ENABLE_WRITES=true

# Apply it
docker compose up -d --force-recreate youtube-mcp

# Confirm
docker compose logs --tail=20 youtube-mcp | grep -i writes
```

No image rebuild and no Google reauthorization is needed for this change.

To turn writes back off, set `false` and run the same `--force-recreate`.

---

## 5. Cloudflare Tunnel

`youtube.example.com` below is a placeholder — substitute your own hostname
here, in `MCP_ALLOWED_HOSTS` (§2.2), and in the Access application.

Ingress for the tunnel:

```yaml
ingress:
  - hostname: youtube.example.com
    service: http://127.0.0.1:8003
  - service: http_status:404
```

Then, in Cloudflare Zero Trust:

- **Access → Applications → Add a self-hosted application** for
  `youtube.example.com`.
- Policy: **Allow**, matched on your specific email address. Not "everyone",
  not a whole domain.
- Enable **Managed OAuth** for the identity flow.
- Enable **Protect with Access** on the tunnel route so the JWT is validated at
  the edge and requests that bypass Access are rejected.

The Node server does not implement a second static bearer token. The
authentication boundary is Cloudflare Access plus the loopback-only port
publication; the channel lock is the authorization boundary for writes.

If you change the hostname, update `MCP_ALLOWED_HOSTS` and recreate the
container, or requests will be answered with `403 Invalid Host header`.

---

## 6. Thumbnails

Two ways to supply one, exactly one per call:

- **`imagePath`** - a file under `/opt/mcp/youtube/media` (mounted read-only at
  `/media`). Paths are canonicalised and confined to that directory; `../`,
  absolute paths and symlinks pointing outside are refused.

  ```bash
  sudo install -m 644 -o 10001 -g 10001 thumb.jpg /opt/mcp/youtube/media/thumb.jpg
  # then: set_thumbnail({ videoId, imagePath: "thumb.jpg" })
  ```

- **`imageUrl`** - a public HTTPS image. Private, loopback, link-local and cloud
  metadata addresses are refused before connecting and again on every redirect;
  the bytes must actually be a JPEG or PNG, not merely claim to be.

JPEG and PNG only, 2 MiB by default.

---

## 7. Routine operations

```bash
# Logs
docker compose logs -f youtube-mcp

# Update to a new build
git pull && docker compose up -d --build youtube-mcp

# Re-authorize (token expired, scopes changed, app republished)
#   -> run `npm run auth` on the MAC, then:
scp ~/.config/youtube-mcp/token.json pi@raspberrypi:/tmp/token.json
sudo install -m 600 -o 10001 -g 10001 /tmp/token.json /opt/mcp/youtube/state/token.json
rm /tmp/token.json
docker compose restart youtube-mcp    # a restart IS enough for a token change
```

A token change only needs a restart, because the token is read from the mounted
file rather than from the environment. Only **env file** changes need
`--force-recreate`.

### Checking state from a client

Call `youtube_auth_status`. It reports whether OAuth is configured, which
channel is authenticated, the allowed channel, whether they match, whether
writes are enabled, and the granted scopes. It never returns tokens or secrets.

---

## 8. Troubleshooting

| Symptom | Cause |
|---|---|
| `403 Invalid Host header` from Cloudflare | Public hostname missing from `MCP_ALLOWED_HOSTS`, or the tunnel sets `httpHostHeader` to something else |
| `403 Invalid Host header` from a local `curl` | `127.0.0.1:8003` missing from `MCP_ALLOWED_HOSTS`. The container binds 8000 and cannot know the published host port; see §2.2 |
| Container exits immediately, log says channel lock FAILED | The stored token belongs to a different channel than `YOUTUBE_ALLOWED_CHANNEL_ID` |
| Container exits, "YOUTUBE_ALLOWED_CHANNEL_ID is required" | Writes enabled in HTTP mode without a channel lock |
| Write tools missing from `tools/list` | `YOUTUBE_ENABLE_WRITES` is not `true`, or you edited the env file and only restarted |
| Writes refuse but reads work | Channel binding is UNVERIFIED - a transient YouTube API problem. Deliberate: writes fail closed while reads keep serving. Retried automatically on the next write |
| Analytics tools error | Token lacks `yt-analytics.readonly`; re-run `npm run auth` |
| Everything worked, then stopped after ~a week | The OAuth app is still **External + Testing**. See §1.2 |
| `EACCES` writing the token | `/opt/mcp/youtube/state` is not owned by `10001:10001` |
