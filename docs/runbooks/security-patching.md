# Security patching (OPS-06)

| Severity             | Fix within        | Who decides              |
| -------------------- | ----------------- | ------------------------ |
| Critical             | **72 hours**      | Whoever is on call       |
| High, Medium and Low | The monthly round | The owner of the release |

The clock starts when a scanner or advisory first reports it, not when somebody reads it. If a high is exploitable in how Montra
uses it, treat it as critical.

> **Partly exercised.** Trivy has been run locally on the filesystem and on saved images, not through the Docker socket as the
> workflow does. The workflow hasn't run on GitHub, and the process below hasn't been used for a real finding.

## Where findings come from

| Source                           | Runs                        | Covers                                                        |
| -------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `security.yml`: `pnpm audit`     | Each PR; weekly             | npm dependencies (high and above)                             |
| `security.yml`: Trivy filesystem | Each PR; weekly             | Lockfiles, secrets, Dockerfile and Terraform misconfiguration |
| `security.yml`: Trivy images     | Each PR; weekly             | The four built images                                         |
| ECR scan on push                 | Each image pushed           | The images actually deployed                                  |
| Renovate                         | Mondays; advisories at once | Opens the update PRs                                          |
| GitHub Dependabot alerts         | Continuous                  | Dependency advisories                                         |

## What to do

1. **Triage.** Is the package in a production image, or only in development? Is the vulnerable code reached? Write the answer on
   the issue.
2. **Fix.** Merge the Renovate PR, or update by hand: `pnpm update <package> --recursive`. For a transitive package with no fix
   from its parent, use `pnpm.overrides` in the root `package.json`, with a comment saying when to remove it.
3. **Base images.** Rebuild picks up new `node:22-bookworm-slim` and `python:3.12-slim` layers. Kratos only changes when the
   version in `infra/kratos/Dockerfile` and `infra/docker-compose.yml` changes. Run the recovery email check in
   [`infra/kratos/templates/README.md`](../../infra/kratos/templates/README.md) after an upgrade.
4. **Release.** Normal path: `develop`, then release. For a critical, use a `hotfix/*` branch from `main`, tag `vX.Y.Z`, and merge
   back into `develop`.
5. **Verify.** Rescan what was deployed. Close the issue with the version it landed in.
6. **If it may have been exploited**, go to [incident response](incident-response.md).

## Accepting a finding

Only with a written reason and an expiry date. Add it to `.trivyignore` or as an inline `#trivy:ignore` comment, with the reason
next to it. Two inline ones exist today, in `infra/terraform/modules/network/main.tf`: the ALB is public because it is the origin
behind Cloudflare, and tasks need outbound internet to reach providers with no fixed addresses.

For npm packages, add the advisory to `pnpm.auditConfig.ignoreGhsas` in the root `package.json`, which skips that one advisory and no
other. JSON has no comments, so the reason and expiry go in the table below. `pnpm audit` still counts it, as `1 high (1 ignored)`.

### Accepted today

| Advisory | Where | Why it's accepted | Expires | Remove when |
| --- | --- | --- | --- | --- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high: `zod` below 4.6.6 can run out of memory on oversized collections | `zod` 3.25.76, only through `expo` > `@expo/cli`, which requires `^3.25.76` | The Expo command-line tool uses it on developer machines and in CI, on our own project files. None of it reaches people: the iOS and Android bundles' source maps list only `zod` 4.6.7 (checked 2026-11-04), which is patched, and the API and web use 4.6.7 too. Forcing version 4 on the tool could break builds, so the fix has to come from Expo. | 2027-02-04 | An Expo release moves off `zod` 3. Check at each Expo SDK upgrade |

At expiry, look again rather than extending by habit: see whether Expo has moved, and repeat the source map check with
`npx expo export --platform android --source-maps` if the bundle has changed.

## Monthly round

- [ ] Merge outstanding Renovate PRs.
- [ ] Rebuild and redeploy, even with no code changes, to pick up base image patches.
- [ ] Update Aurora minors if the maintenance window hasn't.
- [ ] Review `.trivyignore`, inline ignores and the accepted findings above for expired reasons.
- [ ] Check that a `security.yml` run has happened on schedule, and that it is green.
