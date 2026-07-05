-- The id of the Telegram message that carries the Approve/Reject buttons, so a decision
-- made on the web approval page can collapse THAT message to a summary too (keeping every
-- surface consistent), not just post a separate confirmation.
alter table public.purchase_requests
  add column if not exists telegram_message_id bigint;
