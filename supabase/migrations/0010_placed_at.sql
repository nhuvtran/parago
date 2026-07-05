-- When an approved order actually completes (Amazon confirmation page), the extension
-- reports it and we stamp placed_at, so the guardian is told "Order placed" exactly once.
alter table purchase_requests add column if not exists placed_at timestamptz;
