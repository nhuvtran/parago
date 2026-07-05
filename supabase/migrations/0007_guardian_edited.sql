-- True when the guardian approved with changes (dropped items / changed quantities) on
-- the approval page, so the collapsed Telegram summary can flag it as "(modified)".
alter table public.purchase_requests
  add column if not exists guardian_edited boolean not null default false;
