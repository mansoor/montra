# Self-hosted target

Montra on one server with Docker Compose ([ADR-0050](../../docs/design/adr/0050-hosting-anywhere.md) §5, §11). The same
four images as on AWS, from the GitHub Container Registry.

| File                  | What                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.yaml`        | The stack: Caddy, cloudflared, Postgres 16, Kratos and its courier, the auth gateway, two API replicas, the job worker, the doc worker and web |
| `compose.direct.yaml` | For a server with its own address (a VPS): Caddy publishes 80 and 443 and gets certificates                                                    |
| `Caddyfile`           | `app.`, `api.` and `auth.` to web, the API replicas and the auth gateway                                                                       |
| `montra.env.example`  | The settings that aren't secret. Copy to `.env`                                                                                                |
| `setup.sh`            | `secrets` makes and generates `secrets/`; `check` checks the requirements; `init` is the first start                                           |
| `deploy.sh`           | One release: migrations first, then the services, the API replicas one at a time                                                               |

At home, a Cloudflare Tunnel is the way in and nothing is published. Secrets are files in `secrets/` (git-ignored),
read through `NAME_FILE` settings.

Runbooks: [setup](../../docs/runbooks/selfhost-setup.md), [operations](../../docs/runbooks/selfhost-operations.md),
[key wrapping](../../docs/runbooks/key-wrapping.md).

Check without a server, as in review:

```bash
cd infra/selfhost
cp montra.env.example .env     # then set MONTRA_TAG, S3_ENDPOINT and S3_BUCKET to anything
mkdir -p secrets && for s in $(sed -n 's/^  \([a-z_]*\): { file:.*/\1/p' compose.yaml); do : > "secrets/$s"; done
docker compose config -q
```
