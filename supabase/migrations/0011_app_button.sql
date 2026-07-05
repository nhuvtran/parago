-- Whether to show the per-item "Open in Amazon app" button on the approval page (a shopper
-- setting). Null = not specified (the page defaults to showing it).
alter table purchase_requests add column if not exists app_button boolean;
