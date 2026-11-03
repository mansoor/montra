-- Phase 5: system jobs (no workspace) for the FX rates service (CUR-05, ADR-0014). The job queue (ADR-0011)
-- already allows workspace_id null; this adds the one way to create such a job, with at most one queued
-- run per type, so the worker can (re)schedule recurring system work without a separate scheduler.

create unique index job_system_pending on app.job (type) where workspace_id is null and status = 'queued';

-- Returns the queued job's id: the new one, or the one already waiting (whose run_after moves earlier
-- when asked to run sooner).
create function app.schedule_system_job(p_queue text, p_type text, p_run_after timestamptz,
                                        p_payload jsonb default '{}') returns uuid
  language plpgsql volatile security definer set search_path = app, pg_temp as $$
declare jid uuid;
begin
  if p_type !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    raise exception 'invalid system job type %', p_type;
  end if;
  insert into app.job (workspace_id, queue, type, payload, run_after)
  values (null, p_queue, p_type, coalesce(p_payload, '{}'), p_run_after)
  on conflict (type) where workspace_id is null and status = 'queued' do update
    set run_after = least(app.job.run_after, excluded.run_after), updated_at = now()
  returning id into jid;
  return jid;
end $$;

grant execute on function app.schedule_system_job(text, text, timestamptz, jsonb) to montra_app;
