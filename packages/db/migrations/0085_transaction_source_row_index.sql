-- NFR-07: deleting an import's rows (a parse run again after a mapping change, a discarded import) looked up each row's
-- statement-line records one row at a time through the foreign key from app.transaction_source, which had no index on
-- import_row_id. Each lookup read every such record of the workspace, so 5,000 rows took several seconds in a
-- workspace with a few thousand imported lines, and more as it grows. An index only: no data or results change.
create index transaction_source_import_row on app.transaction_source (workspace_id, import_row_id);
