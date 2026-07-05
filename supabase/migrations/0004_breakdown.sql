-- Order-summary breakdown (Items, Shipping, Tax, fees, promotions, Order total) captured
-- from the checkout page, so the guardian sees the real cost on the approval page. Array
-- of { label, amount, total } objects; null when the summary was not available.
alter table public.purchase_requests
  add column if not exists breakdown jsonb;
