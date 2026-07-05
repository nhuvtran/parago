-- Telegram delivery. telegram_links maps an opaque code the extension generates
-- and holds to the guardian's Telegram chat_id (bound when the guardian taps the
-- t.me/<bot>?start=<code> deep link and hits Start). purchase_requests records
-- which chat a request was sent to, so an inline-button callback can be verified
-- to come from that chat. Both are reachable only via the service role in Edge
-- Functions (RLS on, no policies), like purchase_requests.
create table if not exists public.telegram_links (
  code       text primary key,
  chat_id    bigint,
  created_at timestamptz not null default now(),
  bound_at   timestamptz
);

alter table public.telegram_links enable row level security;
-- Intentionally no policies: only the service role (Edge Functions) may read/write.

-- Which Telegram chat a request was sent to (null for email requests). Used to
-- verify a button-tap callback comes from the linked guardian's chat.
alter table public.purchase_requests add column if not exists telegram_chat_id bigint;

-- Telegram requests have no email recipient, so the address is no longer required.
alter table public.purchase_requests alter column guardian_email drop not null;
