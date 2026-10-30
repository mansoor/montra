# ADR-0008: Change feed + WebSocket invalidation for real-time and offline sync

- Status: accepted
- Date: 2026-10-30

## Context
PLT-06 requires < 5 s propagation across devices and household members; PLT-05 requires
mobile offline with field-level last-write-wins and conflict notices.

## Decision
Every synced table writes `change_log(workspace_id, seq, table, row_id, op)` in the same
transaction (per-workspace gapless sequence). The same trigger calls `pg_notify('montra_changes',
workspace_id)`, which Postgres delivers only at commit and collapses per transaction. Each API instance
holds one `LISTEN` connection and pushes `{type:"changes", workspaceId}` to subscribed WebSocket clients
(`/v1/ws`), which then pull `/sync/changes?since` (RLS-filtered). No Redis is needed for fan-out; Redis
pub/sub remains an option if notification volume ever outgrows LISTEN/NOTIFY.
Mobile replays an outbox with `baseVersion` + `changedFields`; the server merges per field.

## Consequences
Simple, debuggable sync without a CRDT framework. Per-workspace sequence row is a write
hot spot only within one workspace (acceptable at household scale).

## Alternatives considered
WatermelonDB sync protocol (similar, more coupling), PowerSync/ElectricSQL (extra infra), CRDTs (overkill for ledger data that needs server validation).
