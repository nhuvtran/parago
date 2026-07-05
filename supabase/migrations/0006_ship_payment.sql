-- Partial ship-to (city/state/zip only) and payment (card type + last 4) captured at
-- checkout, so the guardian sees where it's going and which card without full detail.
alter table public.purchase_requests
  add column if not exists ship_to text,
  add column if not exists payment text;
