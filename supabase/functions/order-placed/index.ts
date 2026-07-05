import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.js';

// The extension calls this when an APPROVED purchase actually completes (Amazon's order-
// confirmation page). We stamp placed_at once (idempotent) and tell the guardian "Order
// placed". Public + unauthenticated like the other endpoints, but safe because: the id is
// an unguessable row id; we act ONLY on an already-approved request; the notification goes
// ONLY to that request's stored chat with a fixed, non-caller-controlled message; and
// placed_at makes it fire at most once, so it can't be used to spam.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });

async function notifyPlaced(row: any) {
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = row?.telegram_chat_id;
  if (!botToken || !chatId) return; // email path has no live channel here; Telegram only
  const tzOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  let when: string;
  try { when = new Date().toLocaleString('en-US', { ...tzOpts, timeZone: (typeof row?.timezone === 'string' && row.timezone) ? row.timezone : 'UTC' }); }
  catch { when = new Date().toLocaleString('en-US', { ...tzOpts, timeZone: 'UTC' }); }
  const amount = typeof row?.total === 'number' && isFinite(row.total) ? ` · $${row.total.toFixed(2)}` : '';
  const text = `Order placed${amount} · ${when}`;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch { /* best effort */ }
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const id = String(body?.id ?? '');
  if (!id) return json({ ok: false }, 400);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: row } = await supabase.from('purchase_requests').select('*').eq('id', id).maybeSingle();
  if (!row) return json({ ok: true });                 // unknown id: no-op, don't leak
  if (row.status !== 'approved') return json({ ok: true }); // only an approved order can be "placed"
  if (row.placed_at) return json({ ok: true, already: true }); // already reported

  // Stamp placed_at, but only if it's still null (guards a race between two reports).
  const { data: upd } = await supabase.from('purchase_requests')
    .update({ placed_at: new Date().toISOString() })
    .eq('id', id).is('placed_at', null)
    .select('id');
  if (!upd || !upd.length) return json({ ok: true, already: true }); // another call won the race

  await notifyPlaced(row);
  return json({ ok: true });
});
