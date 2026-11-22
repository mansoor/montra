-- OPS-05: reference data edited in the staff console survives deploys. `loadReferenceData` runs after every migration
-- (so on every deploy) and puts the shipped content back on any row that differs from it. A row a staff member saved
-- carries the time they saved it here, and the loader leaves such rows alone. Clearing the column hands the row back
-- to the shipped data on the next load.
--
-- montra_admin already has select, insert, update and delete on these four tables (0021), so no grant changes.

alter table ref.merchant add column staff_edited_at timestamptz;
alter table ref.mileage_rate add column staff_edited_at timestamptz;
alter table ref.tax_line add column staff_edited_at timestamptz;
alter table ref.import_profile add column staff_edited_at timestamptz;
