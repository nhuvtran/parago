-- Store the connected chat's display name so the extension can show which Telegram
-- account is linked. Captured at /start bind time (see telegram-webhook).
alter table public.telegram_links add column if not exists chat_name text;
