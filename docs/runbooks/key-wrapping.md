# Key wrapping: the master key, Vault, and moving between them

Each workspace's data key is wrapped by a master key (design 03 §12, [ADR-0050](../design/adr/0050-hosting-anywhere.md)
§3). This runbook covers making and keeping that key, and moving the wrapped keys from one place to another.

| `KMS_MODE` | Where the master key is                        | Settings                                                                  |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `local`    | A file on the server                           | `MASTER_KEY_FILE` (in development, `MASTER_KEY` or nothing)               |
| `vault`    | Vault or OpenBao's Transit engine              | `VAULT_ADDR`, `VAULT_TOKEN_FILE`, `VAULT_TRANSIT_MOUNT`, `VAULT_TRANSIT_KEY` |
| `aws`      | AWS KMS                                        | `AWS_KMS_KEY_ID`, and AWS credentials from the task role                  |

Only the API and the Node worker need these. The doc-worker and Kratos never see a data key.

**Nothing here has been run against a real Vault or AWS KMS.** The Vault adapter is tested against a stand-in that speaks
the Transit API, and the move between modes against a real Postgres with local keys.

## 1. A local master key

Make it on the server, readable only by the user the API runs as. In the API image that is `node`, uid 1000:

```bash
umask 077
openssl rand -base64 32 > /srv/montra/secrets/master_key
sudo chown 1000:1000 /srv/montra/secrets/master_key
sudo chmod 0400 /srv/montra/secrets/master_key
```

Then `KMS_MODE=local` and `MASTER_KEY_FILE=/run/secrets/master_key` (wherever the file is mounted).

- **Start-up refuses a key file that its group or anyone else can read or change**, as ssh does. Fix the mode rather
  than loosening anything.
- In production, `MASTER_KEY` as a plain environment variable is refused: environment variables end up in process
  listings, `docker inspect` and crash reports.

### Back it up, apart from the database

A database backup and this key together are everyone's data. Without the key, the database backups can't be read: the
names, memos, account numbers and files sealed under each workspace's key are lost.

- Keep **two offline copies**: in a password manager, and printed or on a USB stick in a safe place away from the server.
- **Never** put it in the same bucket, folder or backup set as the database backups.
- Check the copies once a year: restore one into a scratch server during the [restore drill](restore-drill.md).

## 2. Vault or OpenBao (`KMS_MODE=vault`)

The master key stays inside Vault. Set up Transit once, with a key Montra can use and nothing else:

```bash
vault secrets enable transit
vault write -f transit/keys/montra type=aes256-gcm96
vault policy write montra-transit - <<'EOF'
path "transit/encrypt/montra" { capabilities = ["update"] }
path "transit/decrypt/montra" { capabilities = ["update"] }
EOF
```

- Give the API a token with only that policy. Prefer a **Vault Agent** that logs in (AppRole, for example) and writes
  the token to a file: point `VAULT_TOKEN_FILE` at it. Montra reads that file again on every call, so renewed tokens are
  picked up without a restart.
- With a Vault namespace (Vault Enterprise or HCP), set `VAULT_NAMESPACE`.
- For a Vault behind a private CA, point `NODE_EXTRA_CA_CERTS` at the CA's certificate. The API image sets it to the RDS
  bundle by default, which only AWS needs.
- **Don't let Vault delete the key.** Keep `deletion_allowed=false` on `transit/keys/montra`, and back up Vault itself
  (its storage and unseal keys) the same way as a local master key: offline, apart from the database.
- Vault rotates its own key versions (`vault write -f transit/keys/montra/rotate`). Montra stores Vault's `vault:vN:…`
  strings, which carry the version, so nothing in Montra changes when it rotates.

## 3. Moving to another mode, or a new local key

The service keeps running throughout. `crypto:rewrap` moves the wrapped keys in batches, and can be stopped and run
again at any point: a key that's already moved is skipped.

1. **Set the new mode, keeping the old one as the previous mode,** on every API and worker, and redeploy:

   | From → to       | Settings                                                                           |
   | --------------- | ---------------------------------------------------------------------------------- |
   | local → vault   | `KMS_MODE=vault`, the `VAULT_*` settings, `KMS_PREVIOUS_MODE=local`; keep `MASTER_KEY_FILE` |
   | local → aws     | `KMS_MODE=aws`, `AWS_KMS_KEY_ID`, `KMS_PREVIOUS_MODE=local`; keep `MASTER_KEY_FILE` |
   | aws → local     | `KMS_MODE=local`, `MASTER_KEY_FILE`, `KMS_PREVIOUS_MODE=aws`; keep `AWS_KMS_KEY_ID` |
   | aws → vault     | `KMS_MODE=vault`, the `VAULT_*` settings, `KMS_PREVIOUS_MODE=aws`; keep `AWS_KMS_KEY_ID` |
   | vault → local   | `KMS_MODE=local`, `MASTER_KEY_FILE`, `KMS_PREVIOUS_MODE=vault`; keep the `VAULT_*` settings |
   | a new local key | `MASTER_KEY_FILE` = the new key, `PREVIOUS_MASTER_KEY_FILE` = the old one, `KMS_PREVIOUS_MODE=local` |

   From now on new keys are wrapped with the new mode, and old ones still unwrap. Every API and worker must be on these
   settings before step 3, or one still on the old settings can't read a key that has moved.

2. **Count first** with a dry run. It writes nothing:

   ```bash
   # in the API image, with the service's settings and the owner's database URL
   node dist/crypto-cli.js rewrap --dry-run
   # or from a checkout
   pnpm --filter @montra/api crypto:rewrap -- --dry-run
   ```

   It also needs `DATABASE_ADMIN_URL` (or `DATABASE_ADMIN_URL_FILE`): it reads every workspace's keys, past row level
   security.

3. **Move them:** the same command without `--dry-run`. It prints progress per batch (`--batch 200` by default) and a
   line per place: workspace keys, backup schedules, restores, and backup jobs. It exits with 1 if any key failed.
   - _"neither adapter unwraps it"_: that key isn't wrapped by either mode. It may be from an older key that was
     replaced without moving. Find which workspace it is from the line, and don't go on to step 4 until it's explained.
   - _"changed while being moved"_: the row was written meanwhile. Run the command again.
   - If it stops part way (a network error, a restart), run it again. It picks up where it was.

4. **Check:** run it once more. Every line should say all keys are already in the new mode, with 0 moved and 0 failed.

5. **Remove `KMS_PREVIOUS_MODE`** (and `PREVIOUS_MASTER_KEY_FILE`) and redeploy. Sign in, open a transaction with a
   memo and a receipt, and check they read.

6. **Retire the old key** after the next good backup and restore drill, not before: a database backup taken before the
   move still needs the old key to be read. Keep the old key with those backups' retention, then destroy it
   (AWS: schedule the key's deletion; local: delete the file and its offline copies; Vault: delete the old key once
   nothing references it).

## What was tested

| What                                                                                         | Result                    |
| -------------------------------------------------------------------------------------------- | ------------------------- |
| `_FILE` settings, both-set refusal, key file permissions (`apps/api/test/key-wrapping.test.ts`) | Pass                      |
| Vault adapter against a stand-in for the Transit API: token, namespace, token file re-read   | Pass                      |
| A local-to-local move on a real Postgres: dry run, stopping part way, resuming, reading memos with the new key alone | Pass |
| A real Vault or OpenBao, AWS KMS                                                             | Not tried                 |
