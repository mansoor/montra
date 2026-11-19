import { sql } from 'kysely';
import type { Trx } from '@montra/db';

/** An earlier upload of the same statement file that something still came of. */
export interface EarlierUpload {
  id: string;
  created_at: Date;
  batch_id: string | null;
}

/**
 * The earliest earlier upload of these bytes that is still live, for "Possible duplicate" (ADR-0051, IMP-03): one with
 * an import that wasn't discarded, one still waiting on the Statements screen or in Review (an intake not put aside),
 * or a plain upload nothing has used yet. An upload whose imports were all discarded and whose statements were all put
 * aside isn't an earlier copy: nothing came of it, so uploading the file again is the way to start over.
 */
export async function earlierLiveUpload(
  trx: Trx,
  workspaceId: string,
  digest: string,
): Promise<EarlierUpload | undefined> {
  const { rows } = await sql<EarlierUpload>`
    select f.id, f.created_at,
           (select b.id from app.import_batch b
             where b.workspace_id = f.workspace_id and b.file_id = f.id and b.status <> 'discarded'
             order by b.created_at limit 1) as batch_id
      from app.file f
     where f.workspace_id = ${workspaceId}::uuid and f.sha256 = ${digest} and f.deleted_at is null
       and (
         exists (select 1 from app.import_batch b
                  where b.workspace_id = f.workspace_id and b.file_id = f.id and b.status <> 'discarded')
         or exists (select 1 from app.document_intake i
                     where i.workspace_id = f.workspace_id and f.id = any (i.file_ids) and i.status <> 'dismissed')
         or (not exists (select 1 from app.import_batch b where b.workspace_id = f.workspace_id and b.file_id = f.id)
             and not exists (select 1 from app.document_intake i
                              where i.workspace_id = f.workspace_id and f.id = any (i.file_ids)))
       )
     order by f.created_at
     limit 1`.execute(trx);
  return rows[0];
}
