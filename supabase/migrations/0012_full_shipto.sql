-- Full delivery recipient + address, sent only when the shopper opts in (fullShipTo).
-- Null when not shared; the approval page then shows only the partial ship_to (City, ST ZIP).
alter table purchase_requests add column if not exists ship_name text;
alter table purchase_requests add column if not exists ship_address text;
