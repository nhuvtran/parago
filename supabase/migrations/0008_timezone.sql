-- The shopper's chosen IANA time zone, so timestamps shown to the guardian (Telegram
-- collapse, approval page) are in their zone instead of the server's UTC.
alter table public.purchase_requests
  add column if not exists timezone text;
