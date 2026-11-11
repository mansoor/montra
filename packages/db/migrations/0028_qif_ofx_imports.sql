-- QIF and OFX/QFX statements (IMP-01, IMP-13, ADR-0030): import batches of those files. QFX is OFX and is stored as 'ofx'.

-- contract: widens the allowed file types; every existing value stays allowed.
alter table app.import_batch drop constraint import_batch_file_type_check;
alter table app.import_batch add constraint import_batch_file_type_check
  check (file_type in ('csv', 'xlsx', 'xls', 'pdf', 'qif', 'ofx'));
