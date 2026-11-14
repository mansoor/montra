-- The store's details from a receipt (RCP-01): address, phone and website as printed, read with the rest of the receipt
-- (extract_receipt.v3) and editable in review. Receipts read before this keep nulls until they are read again.

alter table app.receipt
  add column store_address text check (char_length(store_address) <= 300),
  add column store_phone text check (char_length(store_phone) <= 40),
  add column store_website text check (char_length(store_website) <= 200);
