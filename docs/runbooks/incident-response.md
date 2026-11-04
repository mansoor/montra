# Incident response

For outages, data problems and security incidents (OPS-12).

> **Not exercised.** No real incident or tabletop has used this yet. Run a tabletop before launch.

## Severity

| Sev | What it means                                                                                    | Examples                                                                 | Respond           | Update users    |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------- | --------------- |
| 1   | Service down for most users, ledger integrity in doubt, or a confirmed or likely breach          | API down, reconciliation failures, data exposed across workspaces        | At once, any hour | Hourly          |
| 2   | A major feature down or badly degraded, or a real security weakness with no sign of exploitation | Imports all failing, sign-in failing for some, backups failing for a day | Within 1 hour     | When it changes |
| 3   | Part of a feature affected, with a workaround                                                    | One bank format failing, AI provider down with failover working          | Next working day  | If asked        |
| 4   | Cosmetic or very limited                                                                         | A wrong label                                                            | Normal backlog    | No              |

If unsure, pick the higher one. It's cheap to lower it.

A `ReconciliationFailures` alert is Sev-1 until shown otherwise. Ledger trust is what the product rests on.

## Roles

On a small team one person may hold two, but never lead and fixer in a Sev-1 if a second person is reachable.

| Role            | Does                                                                      | Who |
| --------------- | ------------------------------------------------------------------------- | --- |
| Incident lead   | Runs the incident, decides, keeps the timeline. Doesn't fix things        | TBD |
| Fixer           | Investigates and changes things. Says aloud what they are about to change | TBD |
| Communications  | Status page, support replies, user notices                                | TBD |
| Privacy contact | Decides whether it is a breach, handles notification, talks to counsel    | TBD |

Fill in names and how to reach them, including out of hours, before launch.

## Steps

1. **Open.** Start a channel or a shared document. Write the time and what you know. Name the lead and set the severity.
2. **Assess.** Who is affected, since when, and is it getting worse? Check the SLO dashboard, CloudWatch alarms, Sentry and recent deploys.
3. **Stop the harm first, then find the cause.** Most incidents follow a change, so rollback comes first ([deploy](deploy.md#rollback)).
4. **Communicate.** Update the status page within 30 minutes for a Sev-1. Say what users can't do and when the next update comes. Don't guess
   at causes in public.
5. **Fix and verify.** Confirm with metrics, not just by the absence of complaints.
6. **Close.** Write down the end time. Lower the severity once users are unaffected.
7. **Review.** Within 5 working days for Sev-1 and Sev-2. Blameless: timeline, cause, what helped, what didn't, follow-ups with owners.

## First places to look

| Alert                   | Look at                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 5xx rate or burn rate   | Recent deploys, `/readyz`, Aurora connections, ECS task restarts, Sentry                                                    |
| Unhealthy targets       | Task logs in `/montra-<env>/<service>`. A secret with no value or a failed DB connection stops a task at start              |
| Queue lag               | Worker task count and logs, the failing job type, whether autoscaling can see the metric                                    |
| Metrics missing         | The `metrics-collector` container on API tasks, `METRICS_TOKEN`. Queue and reconciliation alarms are blind while this lasts |
| Reconciliation failures | Which workspaces, what changed. Stop writes if it is growing. Don't "fix" rows until you understand why                     |
| Backup failures         | AWS Backup console: the failed job's message. Check the KMS key policy and the cross-account setting                        |
| AI provider errors      | Failover should be active (OPS-07). Check the review queue is taking the work                                               |
| Aurora CPU, memory      | Performance Insights, top statements, recent migrations                                                                     |

## Security incidents

Everything above, and also:

1. **Bring in the privacy contact at once.**
2. **Preserve evidence before changing things.** Don't terminate compromised tasks until logs are safe. Snapshot what you can. Copy CloudTrail,
   ALB, application and `audit_log` records somewhere the attacker can't reach, such as the backup account.
3. **Contain.** Revoke sessions and tokens, block at Cloudflare, rotate what may be exposed: database passwords, `KRATOS_*`, Stripe, SES SMTP,
   Anthropic, Sentry, `METRICS_TOKEN`, deploy role trust.
4. **Keep a written log** of who did what and when, and what was known at each time. Regulators ask for this.
5. **Don't discuss details outside the incident channel.** Take legal advice before saying anything public.

### Breach notification

**Affected users must be told within 72 hours of a confirmed breach (OPS-12).**

- The clock starts when you have reasonable certainty that personal data was exposed, lost or altered, **not** when the investigation ends. Write
  down that moment.
- Don't wait for full details. Send what you know and follow up.
- Regulators may have their own deadlines, and these can differ by country and US state. GDPR, for example, asks for notice to the authority
  within 72 hours. The legal review on the [launch checklist](launch-checklist.md) should say which apply.
- If an AI or OCR provider or other processor is involved, check what its DPA requires of each side.

Each notice says:

- what happened, in plain words, and when;
- what data was affected, for this user if you can tell;
- what we have done;
- what they should do, such as changing a password or watching accounts;
- how to reach us.

Send it by email to the account address, and show an in-app notice. Keep a list of who was notified and when.

To work out who was affected: `audit_log`, application logs by correlation id, and the `support_grant` records for staff access.

## After any security incident

- [ ] Timeline and evidence stored safely.
- [ ] All notifications sent and logged, or the decision not to notify recorded with reasons.
- [ ] Credentials rotated, and rotation verified.
- [ ] Review done, with follow-ups tracked to closure.
