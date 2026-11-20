-- Discarding an import that was never committed (IMP-09): wrong file, wrong account, a bad column split. The batch
-- stays, as `discarded`, because a statement on the Statements screen (app.document_intake.import_batch_id) and the
-- audit log may point at it; its preview rows and pending jobs go, and its uploaded file is kept.

alter table app.import_batch drop constraint import_batch_status_check;
alter table app.import_batch add constraint import_batch_status_check
  check (status in ('uploaded', 'parsing', 'needs_mapping', 'preview', 'committing', 'committed', 'failed', 'undone',
                    'discarded'));

-- -----------------------------------------------------------------------------
-- The discarded import's jobs still waiting in the queue are cancelled: montra_app may only insert and read jobs.
-- Only for a batch of the current workspace that the caller may write and that is discarded already; a job already
-- running finishes, and the parse job leaves a discarded batch alone.
-- -----------------------------------------------------------------------------
create function app.cancel_import_jobs(p_batch uuid) returns integer
  language sql volatile security definer set search_path = app, pg_temp as $$
  with cancelled as (
    update app.job j
       set status = 'cancelled', finished_at = now(), updated_at = now()
      from app.import_batch b
     where b.workspace_id = app.current_workspace_id() and b.id = p_batch and b.status = 'discarded'
       and app.can_write_entity(b.entity_id)
       and j.workspace_id = b.workspace_id and j.status = 'queued'
       and (j.id = b.job_id or j.payload ->> 'batchId' = b.id::text)
    returning 1)
  select count(*)::integer from cancelled
$$;
revoke all on function app.cancel_import_jobs(uuid) from public;
grant execute on function app.cancel_import_jobs(uuid) to montra_app;
