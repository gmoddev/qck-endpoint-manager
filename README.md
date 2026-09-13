# Endpoint Workspace Manager

A small, self-hosted control plane for short links, standalone HTML pages, and directory-backed static websites. It separates the public content hostname from an OAuth-protected management hostname and permits exactly one configured user to administer content.

The application has no third-party runtime dependencies. It uses Node.js built-ins, including `node:sqlite`, and ships with a hardened Docker Compose deployment using Caddy for automatic HTTPS.

## Features

- HTTP 301/302 redirect endpoints.
- Complete inline HTML endpoints.
- Directory-backed static websites at `/<slug>/`.
- Nested file and directory explorer.
- Browser editor with line numbers, cursor position, find/replace, tab insertion, and `Ctrl/Cmd+S`.
- Live site preview.
- Multi-file and complete-folder uploads.
- Binary assets up to 100 MiB per file.
- Create, rename, move, and delete operations.
- Revision checks that reject stale saves.
- Private recovery snapshots before overwrites, renames, and deletions.
- HTTP byte-range support for audio and video.
- One-user OAuth authorization.
- Separate public and management hostnames.

## Architecture

```text
Internet
  └─ Caddy :80/:443
       ├─ links.example.org  ─┐
       └─ manage.example.org ─┴─ app:3000 (private Docker network)
                                  ├─ SQLite metadata volume
                                  └─ static workspace volume
```

Only Caddy publishes host ports. The Node application, SQLite database, workspace files, Docker socket, and Caddy administration API are not publicly exposed.

## Requirements

- A Linux server with Docker Engine and the Compose plugin.
- Two DNS names, such as `links.example.org` and `manage.example.org`.
- Public inbound TCP ports 80 and 443. UDP 443 is optional but enables HTTP/3.
- A Discord OAuth application.

Node.js 24 LTS is used by the included image. Caddy uses its official Alpine image.

## Quick start

Clone the repository and generate a configuration:

```bash
git clone https://github.com/gmoddev/qck-endpoint-manager.git
cd qck-endpoint-manager
npm run setup -- \
  --public-host links.example.org \
  --admin-host manage.example.org \
  --client-id YOUR_DISCORD_APPLICATION_ID \
  --authorized-user-id YOUR_DISCORD_USER_ID \
  --app-name "My Endpoint Manager"
```

The setup command generates a random session-signing secret and writes `.env` with owner-only permissions on supported systems. It deliberately does not accept the OAuth client secret on the command line, where it could leak into shell history.

Open `.env` and replace:

```dotenv
OAUTH_CLIENT_SECRET=replace-with-your-client-secret
```

Validate and launch:

```bash
npm run validate
docker compose up -d --build
docker compose ps
```

## DNS

Create these records at your DNS provider:

| Type | Name | Value |
| --- | --- | --- |
| A | public hostname | server IPv4 address |
| A | management hostname | server IPv4 address |

Add equivalent AAAA records only when the server has working public IPv6 and the firewall permits it.

Caddy obtains and renews public certificates automatically. Both DNS names must resolve to the server, and ports 80/443 must reach Caddy. If Cloudflare proxying is enabled, use **Full (strict)** SSL mode after Caddy has a valid origin certificate.

## Discord OAuth

1. Create or select an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy its **Application ID** into `OAUTH_CLIENT_ID`.
3. Add this exact redirect URI, substituting your management hostname:

   ```text
   https://manage.example.org/oauth/callback
   ```

4. Copy the client secret into `OAUTH_CLIENT_SECRET`.
5. Put the only permitted Discord user ID in `OAUTH_AUTHORIZED_USER_ID`.

The requested Discord scope is only `identify`. OAuth credentials and session secrets belong exclusively in `.env`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `APP_NAME` | Branding displayed in the management interface. |
| `PUBLIC_HOST` | Hostname that serves redirects and static content. |
| `ADMIN_HOST` | Separate hostname for OAuth and management. |
| `HOST` | Node bind address; use `0.0.0.0` inside Docker. |
| `PORT` | Internal application port. |
| `DATABASE_PATH` | SQLite metadata path. |
| `STATIC_SITES_PATH` | Root directory for static workspaces. |
| `SESSION_SECRET` | At least 32 random characters used to sign sessions and CSRF tokens. |
| `OAUTH_PROVIDER_NAME` | Provider label shown to users. |
| `OAUTH_AUTHORIZE_URL` | OAuth authorization endpoint. |
| `OAUTH_TOKEN_URL` | OAuth token endpoint. |
| `OAUTH_USERINFO_URL` | OAuth identity endpoint. |
| `OAUTH_SCOPES` | Space-delimited OAuth scopes. |
| `OAUTH_USER_ID_FIELD` | Dot path to the user ID in the provider response. |
| `OAUTH_CLIENT_ID` | OAuth application/client ID. |
| `OAUTH_CLIENT_SECRET` | OAuth client secret. |
| `OAUTH_AUTHORIZED_USER_ID` | The sole account allowed to manage content. |

For a provider other than Discord, change the OAuth endpoint, scope, and user-ID-field variables manually.

## Storage and recovery

Docker Compose creates four named volumes:

- `endpoint-data`: SQLite metadata.
- `endpoint-sites`: static workspace content and recovery snapshots.
- `caddy-data`: certificates and ACME state.
- `caddy-config`: Caddy runtime state.

Each workspace keeps snapshots under `sites/<slug>/.history/`. That directory is hidden from the editor and cannot be served publicly. Snapshots are intentionally not an alternative to server backups.

To create a portable application-data backup:

```bash
docker compose exec -T app tar -czf - data sites > endpoint-manager-backup.tar.gz
```

Protect backup files as carefully as the live server because they may contain private or unpublished content.

## Updating

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
```

Back up the data and site volumes before major upgrades.

## Development

Node.js 22 or newer is required because the application uses built-in SQLite.

```bash
cp .env.example .env
npm test
node src/Server.js
```

Tests cover path confinement, recovery snapshots, stale-save protection, static routing, media ranges, authenticated workspace pages, and CSRF-protected file saves.

## Security notes

- Never commit `.env`, database files, site content, backups, or OAuth credentials.
- Keep the application behind Caddy or another trusted reverse proxy.
- Do not publish the Node application port or Docker socket.
- Keep `PUBLIC_HOST` and `ADMIN_HOST` separate. Public HTML is intentionally isolated from the management session cookie.
- Use a firewall that permits SSH and public web traffic only as required.
- Rebuild images regularly for Node and Caddy security updates.
- Treat uploaded HTML and JavaScript as executable public content.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.

## License

MIT
