-- Allow a 'notified' status for heads-up messages (a purchase that did NOT need approval
-- but the shopper opted to inform the approver anyway). Not actionable, counts for rate.
alter table purchase_requests drop constraint if exists purchase_requests_status_check;
alter table purchase_requests add constraint purchase_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'notified'));
