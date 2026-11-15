# Self-hosted setup: Montra on your own server

Montra on one server with Docker Compose ([ADR-0050](../design/adr/0050-hosting-anywhere.md) §5 and §11). This is how
the owner starts: a server at home, shared with family and friends, reached through a Cloudflare Tunnel. §8 covers the
same stack on a VPS, which is where it moves when real customers come (ADR-0050 §10).

The files are in [`infra/selfhost`](../../infra/selfhost): `compose.yaml`, `Caddyfile`, `montra.env.example`,
`setup.sh` and `deploy.sh`. Day-to-day running is in [self-hosted operations](selfhost-operations.md).

> **Not yet run on a real server.** The stack was brought up locally with Docker Desktop, images built from this
> repository, MinIO for files and Mailpit for email. Neither a real Cloudflare Tunnel nor a real sending service has
> been used. Correct this page when reality differs.

## 1. What you need

| What                         | For                                                     | Notes                                                                 |
| ---------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| A small always-on computer   | Running everything                                      | 4 cores, 8 GB of memory, two SSDs of the same size. 4 GB works        |
| A UPS                        | Shutting down cleanly in a power cut                    | One with a USB data cable, supported by NUT                           |
| A domain                     | `app.`, `api.` and `auth.` names                        | Its DNS at Cloudflare (the free plan is enough)                       |
| A Cloudflare account         | DNS, the tunnel, WAF and rate limits                    |                                                                       |
| An email sending service     | Sign-up codes, recovery, alerts                         | Postmark, Mailgun, Amazon SES or similar, with SMTP                   |
| An S3-compatible bucket      | Receipts, statements and other files                    | Backblaze B2 or Cloudflare R2. Not on the server: see ADR-0050 §4      |
| A GitHub account with access | Pulling the images from the GitHub Container Registry   | A token that can only read packages                                   |

Montra itself needs only containers, PostgreSQL 16, S3-compatible storage, SMTP and secrets (ADR-0050 §1).
`./setup.sh check` checks them.

**Check your internet contract.** Some home ISPs forbid running servers. A tunnel makes no difference to that.

## 2. The machine

Install a current Ubuntu LTS or Debian stable, server edition. Then:

1. **Mirror the disks.** Put the system and `/var/lib/docker` on a RAID 1 mirror (mdadm, chosen in the installer) or a
   ZFS mirror. One failed disk then means replacing it, not restoring from backups.
2. **Encrypt the disks** (LUKS, chosen in the installer). The database and `secrets/` sit on them. With a key typed at
   boot, the server can't restart unattended after a power cut. Choose: a passphrase at boot (safer, needs someone at
   home), or unlocking from a TPM with `systemd-cryptenroll` (unattended, protects a disk that leaves the house).
3. **Watch the disks:** `sudo apt install smartmontools`, and in `/etc/smartd.conf` add `-m <your email>` to the
   `DEVICESCAN` line. For mdadm, set `MAILADDR` in `/etc/mdadm/mdadm.conf`. Both need the server to send mail: install
   `msmtp-mta` pointed at your sending service, with its own SMTP credentials.
4. **The UPS:** `sudo apt install nut`, then follow NUT's guide for your model, with `SHUTDOWNCMD "/sbin/shutdown -h now"`
   and a shutdown when the battery is low. In the BIOS, set **restore on AC power loss** to "power on", so the server
   starts by itself when power returns. Docker starts the containers (`restart: unless-stopped`).
5. **Updates:** `sudo apt install unattended-upgrades` and keep its default of security updates. Reboots are covered in
   [operations](selfhost-operations.md#2-patching).
6. **The clock:** `timedatectl` should say `System clock synchronized: yes`. Sign-in codes depend on it.
7. **No inbound ports.** With the tunnel, the router forwards nothing to the server. Leave the firewall closed
   (`sudo ufw default deny incoming && sudo ufw allow from <your LAN>/24 to any port 22 && sudo ufw enable`). Docker
   publishes no ports in this stack, so it doesn't open holes around ufw.

## 3. Docker and the folder

```bash
curl -fsSL https://get.docker.com | sh        # Docker Engine and the compose plugin (2.24 or newer)
sudo adduser --uid 1000 montra                  # skip if uid 1000 is already your own user
sudo usermod -aG docker montra
sudo install -d -o montra -g montra /srv/montra/infra
```

Every Montra container runs as uid 1000, and the secret files are owned by it. If uid 1000 is already your own user,
use that account in place of `montra`.

Copy the stack to the server (deploys from GitHub do this for you, §11):

```bash
# from a checkout of the repository
tar -C infra -czf - selfhost db/production-roles.sql | ssh montra@<server> 'tar -C /srv/montra/infra -xzf -'
```

Log Docker in to the GitHub Container Registry with a classic token that has only `read:packages`:

```bash
echo <token> | docker login ghcr.io -u <github user> --password-stdin
```

## 4. Cloudflare and the tunnel

1. Add the domain to Cloudflare and change its nameservers at the registrar.
2. In Zero Trust → Networks → Tunnels, **create a tunnel** (cloudflared). Copy its token.
3. Add three **public hostnames**, each to the service `HTTP` `caddy:80`:
   `app.<domain>`, `api.<domain>` and `auth.<domain>`. Cloudflare makes the DNS records.
   - Caddy chooses the site by the Host header. If a page answers with Caddy's empty 200, open the hostname's
     Additional settings → HTTP Settings and set **HTTP Host Header** to the same hostname.
4. SSL/TLS → Edge Certificates: **Always Use HTTPS** on, minimum TLS 1.2.
5. Security: turn on the WAF's managed rules (free plan) and a rate-limiting rule on `auth.<domain>` (for example 20
   requests per 10 seconds per IP for `/self-service/login*`), as `infra/terraform/modules/edge` does for AWS.
6. **For deploys from GitHub**, add one more public hostname: `ssh.<domain>` to `SSH` `<server's LAN address>:22`.
   Then in Zero Trust → Access → Applications, add a self-hosted application for `ssh.<domain>` with a policy that
   allows only a **service token** (Access → Service credentials → create one; keep its ID and secret for §11).
   Without this, deploy by hand with `deploy.sh` on the server.

## 5. Email

At the sending service:

1. Verify the domain, and add the SPF, DKIM and return-path records it gives you in Cloudflare DNS.
2. Add a DMARC record: `_dmarc.<domain>` TXT `v=DMARC1; p=quarantine; rua=mailto:<you>`.
3. Create SMTP credentials. Use port 587 (STARTTLS); some home ISPs block port 25 outbound, and nothing here uses it.

The API and Kratos each get the SMTP URL as a secret (§9). The addresses in `MAIL_FROM` and `KRATOS_FROM_ADDRESS` must
be on the verified domain.

## 6. The bucket

1. Create a **private** bucket (Backblaze B2: private; Cloudflare R2: no public access).
2. Create an access key **scoped to that bucket alone**, with read and write.
3. Note the endpoint and region: B2 `https://s3.<region>.backblazeb2.com` and the region; R2
   `https://<account id>.r2.cloudflarestorage.com` and `auto`.

Files are encrypted at rest by the provider (ADR-0050 §4). Backups of the bucket go to a second provider (step 3 of
ADR-0050).

## 7. Settings

```bash
cd /srv/montra/infra/selfhost
cp montra.env.example .env && chmod 600 .env
```

Fill in `.env`: the three hostnames and `COOKIE_DOMAIN`, the mail addresses, the bucket's endpoint, name and region,
and `MONTRA_TAG` (the release to start with: a tag that `deploy.yml` pushed, `<commit>-<attempt>`).
Keep `BILLING_MODE=off` for family and friends, and `KMS_MODE=local`.

## 8. On a VPS instead of at home

The stack is the same. In `.env`:

```bash
COMPOSE_FILE=compose.yaml:compose.direct.yaml
COMPOSE_PROFILES=                     # no tunnel
TRUSTED_PROXIES=173.245.48.0/20 103.21.244.0/22 …   # all of https://www.cloudflare.com/ips/, space-separated
```

Caddy then publishes 80 and 443, the only ports published, and gets certificates from Let's Encrypt. In Cloudflare,
point `app.`, `api.` and `auth.` at the VPS's address with the proxy on (orange cloud), and set SSL/TLS to
**Full (strict)**. Firewall the VPS so 80 and 443 accept only Cloudflare's ranges, and SSH only your address.
`TRUSTED_PROXIES` lets Caddy pass the visitor's address on; the API counts two proxies (`TRUST_PROXY_HOPS=2`) either way.

## 9. Secrets

```bash
./setup.sh secrets
```

It creates `secrets/` and generates, without ever overwriting:

- the Postgres superuser's password, and a password per database role, written into the five database URLs;
- `master_key`, the key that wraps every workspace's data key (`KMS_MODE=local`);
- Kratos's cookie, cipher and pagination secrets, the webhook secret, the auth gateway's key and the metrics token.

Then fill in, one value per file, with `sudoedit secrets/<name>`:

| File                      | Value                                                                       |
| ------------------------- | --------------------------------------------------------------------------- |
| `s3_access_key`           | The bucket's key ID                                                         |
| `s3_secret_key`           | The bucket's secret                                                         |
| `mail_url`                | `smtp://<user>:<password>@<host>:587` (URL-encode the password)             |
| `kratos_smtp_url`         | The same server for Kratos: `smtp://<user>:<password>@<host>:587/`          |
| `cloudflare_tunnel_token` | The tunnel's token (§4). Empty on a VPS                                     |
| `anthropic_api_key`       | Optional: without it, categorizing uses rules and history only              |
| `sentry_dsn`              | Optional: error reports                                                     |
| `stripe_*`                | Empty while `BILLING_MODE=off`                                              |

Each file is owned by uid 1000 with mode 0400 (`postgres_password` and `role_passwords` by root), and Compose mounts
it at `/run/secrets/<name>`. The services read them through `NAME_FILE` settings (ADR-0050 §2). An empty file means a
secret not in use.

**Back up `secrets/master_key` now**, offline and apart from the database backups: in a password manager, and printed
or on a USB stick somewhere safe. Without it, no backup of the database can be read. See
[key wrapping](key-wrapping.md#1-a-local-master-key). Keep a copy of the whole `secrets/` folder the same way.

## 10. First start

```bash
./setup.sh check     # changes nothing; fix every FAIL line
./setup.sh init
```

`check` looks at Docker and Compose, `.env`, every secret's owner, mode and content, whether the bucket's endpoint,
the SMTP server and ghcr.io answer, free disk space and memory, and warns about what the machine lacks: a disk mirror,
SMART monitoring, UPS software, an encrypted disk, a synchronized clock.

`init` starts Postgres, creates the database roles and the `kratos` database (`infra/db/production-roles.sql`), then
runs `deploy.sh` for `MONTRA_TAG`: migrations, then every service.

Then:

1. Open `https://app.<domain>` and sign up with your own address. The code comes by email.
2. Make yourself staff:
   `docker compose run --rm migrate node dist/staff-cli.js <your email> admin`.
3. Set up two-step verification (Settings → Security). Owners must, by default.
4. Invite family and friends from the app. With `BILLING_MODE=off` nobody is asked to pay.

## 11. Deploys from GitHub

`deploy.yml` deploys an environment whose `DEPLOY_TARGET` variable is `selfhost`. It builds the four images, pushes them
to `ghcr.io/<owner>/<repo>`, copies `infra/selfhost` to the server and runs `deploy.sh` there over SSH.

In GitHub → Settings → Environments → `prod` (or the environment you use):

| Kind     | Name                                | Value                                                                       |
| -------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Variable | `DEPLOY_TARGET`                     | `selfhost`                                                                  |
| Variable | `SELFHOST_APP_HOST`, `_API_HOST`, `_AUTH_HOST` | The three hostnames: the web image is built for them             |
| Variable | `SELFHOST_SSH_HOST`                 | `ssh.<domain>` through the tunnel, or the VPS's address                     |
| Variable | `SELFHOST_SSH_USER`                 | `montra` (the default)                                                      |
| Variable | `SELFHOST_DIR`                      | `/srv/montra` (the default)                                                 |
| Variable | `SELFHOST_SSH_KNOWN_HOSTS`          | The line for `ssh.<domain>` from `ssh-keyscan` run on the server itself     |
| Variable | `SELFHOST_SSH_VIA_CLOUDFLARE_ACCESS`| `true` at home, so SSH goes through the tunnel                              |
| Secret   | `SELFHOST_SSH_KEY`                  | A private key made for this alone, whose public key is in `~montra/.ssh/authorized_keys` |
| Secret   | `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | The Access service token (§4.6)                                 |

Limit the deploy key on the server to running `deploy.sh` if you like, with `command=` in `authorized_keys`, but then
the copy step can't run, and you copy the files yourself on each change to `infra/selfhost`.

The images are private packages: the server's `docker login` (§3) is what lets it pull them.

## 12. What was tested

| What                                                                                                 | Result |
| ---------------------------------------------------------------------------------------------------- | ------ |
| `docker compose config` with the tunnel (no port published) and with `compose.direct.yaml` (80, 443) | Pass   |
| `caddy validate` and `caddy adapt` for both, with the trusted proxies set                            | Pass   |
| `shellcheck` on `setup.sh` and `deploy.sh`; `actionlint` on `deploy.yml`                             | Pass   |
| The whole stack up locally from `setup.sh init`, see [operations §8](selfhost-operations.md#8-what-was-tested) | Pass   |
| A real tunnel, sending service, bucket, UPS or disk failure                                          | Not tried |
