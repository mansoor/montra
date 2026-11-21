-- Local-mode AI results are used (06 §2, backlog item 2). A client on the user's network answers a parked task; the
-- server then uses that answer when the same work runs again, in place of calling a provider.

-- The hash of the parked request (prompt version, context and input), so the same request is parked once and its
-- answer is found when the work runs again.
alter table app.ai_task add column input_hash text check (length(input_hash) = 64);
-- Row tasks (categorize): each wire item's cache key, in wire order (i0, i1, ...), so an answer is used item by item
-- whatever batches the next run makes.
alter table app.ai_task add column item_keys text[];
-- Who the work was for: the follow-up that applies the answer runs as them, with their access.
alter table app.ai_task add column created_by uuid references app.app_user (id) on delete set null;

create index ai_task_answer on app.ai_task (workspace_id, task, input_hash) where input_hash is not null;
create index ai_task_item_keys on app.ai_task using gin (item_keys) where item_keys is not null;
