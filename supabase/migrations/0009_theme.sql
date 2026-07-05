-- The shopper's UI theme (light | dark | amoled), so the approval page can default to
-- the same look as the extension until the guardian picks one on the page.
alter table purchase_requests add column if not exists theme text;
