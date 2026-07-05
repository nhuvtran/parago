import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.js';
import { isActionable } from '../_shared/decision.js';
import { parseCallbackData, buildTelegramMessage } from '../_shared/telegram.js';

// Telegram webhook + link helper. Two audiences:
//  - Telegram POSTs bot updates here (verified by the secret token set on the
//    webhook): /start binds a chat to a code; a button tap records the verdict.
//  - The extension GETs ?action=info (bot username, to build the deep link) and
//    ?action=link-status&code=... (has this code been linked yet?).
// State changes use the service role; the shopper's device never touches the DB.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });

async function tg(method: string, payload: unknown) {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json().catch(() => null);
}

// Compact one-line summary that replaces the full item list once a decision is made,
// so the approval message is not left as a wall of text.
// Now, formatted in the shopper's chosen IANA zone (row.timezone), else UTC. The zone
// abbreviation is shown so the guardian knows which clock it is.
function fmtWhen(tz: unknown): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  if (typeof tz === 'string' && tz) { try { return new Date().toLocaleString('en-US', { ...opts, timeZone: tz }); } catch (e) { /* bad zone */ } }
  return new Date().toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
}

function decisionSummary(verdict: string, row: any): string {
  const total = (typeof row?.total === 'number' && isFinite(row.total)) ? ` · $${row.total.toFixed(2)}` : '';
  const n = Array.isArray(row?.items) ? row.items.length : 0;
  const items = n ? ` · ${n} item${n > 1 ? 's' : ''}` : '';
  const modified = row?.guardian_edited ? ' (modified)' : '';
  return `${verdict === 'approved' ? 'Approved' : 'Rejected'}${total}${items} · ${fmtWhen(row?.timezone)}${modified}`;
}

// Edit the approval message down to that summary, replacing the item list + Approve/
// Reject with a single Undo button — so an accidental tap can be corrected (we all make
// mistakes). A photo message carries its body in a caption; a text message in text.
async function collapseMessage(chatId: unknown, message: any, verdict: string, row: any) {
  const messageId = message?.message_id;
  if (!messageId) return;
  const text = decisionSummary(verdict, row);
  const reply_markup = { inline_keyboard: [[{ text: 'Undo', callback_data: 'u:' + row.token }]] };
  const isPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  await tg(isPhoto ? 'editMessageCaption' : 'editMessageText',
    isPhoto ? { chat_id: chatId, message_id: messageId, caption: text, reply_markup }
            : { chat_id: chatId, message_id: messageId, text, reply_markup, disable_web_page_preview: true });
}

// Undo: restore the full item list + Approve/Reject buttons on the same message, so the
// guardian can decide again. Rebuilds the body from the stored row; the "See full
// details" link is reconstructed from the server default (APPROVE_URL).
async function restoreMessage(chatId: unknown, message: any, row: any) {
  const messageId = message?.message_id;
  if (!messageId) return;
  const approveBase = (Deno.env.get('APPROVE_URL') ?? 'https://elzgnyc.github.io/parago/approve.html').replace(/\/$/, '');
  const link = `${approveBase}?token=${row.token}`;
  const rebuilt = buildTelegramMessage({ chatId, total: row.total, items: row.items, link, token: row.token });
  const btn = rebuilt.sends.find((s: any) => s.payload.reply_markup) || rebuilt.sends[rebuilt.sends.length - 1];
  const body = btn.payload.caption ?? btn.payload.text;
  const isPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  await tg(isPhoto ? 'editMessageCaption' : 'editMessageText',
    isPhoto ? { chat_id: chatId, message_id: messageId, caption: body, reply_markup: btn.payload.reply_markup }
            : { chat_id: chatId, message_id: messageId, text: body, reply_markup: btn.payload.reply_markup, disable_web_page_preview: true });
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;

  const url = new URL(req.url);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Extension-facing GET actions. Non-secret: the bot username is public, and
  // link-status only reveals a boolean for a code the caller already holds.
  if (req.method === 'GET') {
    const action = url.searchParams.get('action');
    if (action === 'info') {
      const me = await tg('getMe', {});
      return json({ username: (me && me.ok && me.result) ? me.result.username : null });
    }
    if (action === 'link-status') {
      const code = url.searchParams.get('code') || '';
      if (!code) return json({ linked: false });
      const { data } = await supabase.from('telegram_links').select('chat_id, chat_name').eq('code', code).maybeSingle();
      return json({ linked: !!(data && data.chat_id), name: (data && data.chat_name) || null });
    }
    return json({ error: 'bad_action' }, 400);
  }

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Verify the update actually came from Telegram (the secret token echoed from
  // setWebhook). Fail CLOSED when the secret is not configured: an unset secret
  // must be a hard error, not a silent bypass that would let anyone POST forged
  // /start or callback updates and drive the bot as a spam relay.
  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'webhook_not_configured' }, 503);
  if (req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return json({ ok: false }, 401);
  }

  let update: any;
  try { update = await req.json(); } catch { return json({ ok: true }); } // ignore malformed updates

  // /start <code>: bind this chat to the code. First bind wins; a different chat
  // trying to claim an already-bound code is refused (the shopper rotates the code
  // in the extension to re-link a new device).
  if (update.message && typeof update.message.text === 'string') {
    const chat = update.message.chat || {};
    const chatId = chat.id;
    // Display name of the connecting chat, so the extension can show which account is
    // linked. Private chats carry first/last name; fall back to username.
    const chatName = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || null;
    const text = update.message.text.trim();
    if (text.startsWith('/start')) {
      const code = text.slice('/start'.length).trim();
      if (!code) {
        await tg('sendMessage', { chat_id: chatId, text: 'Open "Link Telegram" in the Parago extension to connect your account.' });
        return json({ ok: true });
      }
      // Bind atomically: ensure a row exists, then claim it only if still unbound.
      // The conditional UPDATE (is chat_id null) is the lock, so exactly one chat
      // wins a fresh code even if two /start updates race. A read-then-upsert would
      // be last-write-wins and silently let a second chat steal the binding.
      await supabase.from('telegram_links').upsert({ code }, { onConflict: 'code', ignoreDuplicates: true });
      const { data: bound } = await supabase.from('telegram_links')
        .update({ chat_id: chatId, chat_name: chatName, bound_at: new Date().toISOString() })
        .eq('code', code).is('chat_id', null).select('chat_id');
      if (bound && bound.length) {
        await tg('sendMessage', { chat_id: chatId, text: 'Connected. Approval requests will appear here with Approve and Reject buttons.' });
        return json({ ok: true });
      }
      // Already bound: to this chat (a harmless re-Start) or to a different device.
      const { data: cur } = await supabase.from('telegram_links').select('chat_id').eq('code', code).maybeSingle();
      const mine = cur && String(cur.chat_id) === String(chatId);
      await tg('sendMessage', { chat_id: chatId, text: mine ? 'Already connected. You are all set.' : 'This link is already connected to another device.' });
      return json({ ok: true });
    }
    return json({ ok: true });
  }

  // Button tap: record the verdict, guarded by the single-use token AND the bound
  // chat, then clear the buttons and confirm.
  if (update.callback_query) {
    const cq = update.callback_query;
    const cbId = cq.id;
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const messageId = cq.message && cq.message.message_id;
    const parsed = parseCallbackData(cq.data);
    if (!parsed) { await tg('answerCallbackQuery', { callback_query_id: cbId }); return json({ ok: true }); }

    const { data: row } = await supabase.from('purchase_requests').select('*').eq('token', parsed.token).maybeSingle();
    // The tap must come from the exact chat this request was sent to.
    if (!row || row.telegram_chat_id == null || String(row.telegram_chat_id) !== String(chatId)) {
      await tg('answerCallbackQuery', { callback_query_id: cbId, text: 'This request is not available.' });
      return json({ ok: true });
    }

    // Undo an accidental decision: flip a decided request back to pending and restore the
    // full message + Approve/Reject buttons so the guardian can decide again.
    if (parsed.verdict === 'undo') {
      const { data: reverted } = await supabase.from('purchase_requests')
        .update({ status: 'pending', decided_at: null, token_used: false })
        .eq('token', parsed.token).in('status', ['approved', 'rejected']).select('id');
      if (!reverted || !reverted.length) {
        await tg('answerCallbackQuery', { callback_query_id: cbId, text: 'Nothing to undo.' });
        return json({ ok: true });
      }
      await tg('answerCallbackQuery', { callback_query_id: cbId, text: 'Reopened' });
      await restoreMessage(chatId, cq.message, row);
      return json({ ok: true });
    }

    const guard = isActionable(row, Date.now());
    if (!guard.ok) {
      // Already decided (e.g. on the web page) or expired. Collapse to the RECORDED
      // verdict so the Telegram message matches every other surface — not just a
      // buttons-cleared full list.
      const st = row.status;
      if (st === 'approved' || st === 'rejected') {
        await tg('answerCallbackQuery', { callback_query_id: cbId, text: st === 'approved' ? 'Already approved.' : 'Already rejected.' });
        await collapseMessage(chatId, cq.message, st, row);
      } else {
        await tg('answerCallbackQuery', { callback_query_id: cbId, text: guard.reason === 'expired' ? 'This request has expired.' : 'This request is no longer available.' });
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      }
      return json({ ok: true });
    }
    const { data: updated, error } = await supabase.from('purchase_requests')
      .update({ status: parsed.verdict, decided_at: new Date().toISOString(), token_used: true })
      .eq('token', parsed.token).eq('status', 'pending') // double-guard against races
      .select('id');
    if (error) {
      await tg('answerCallbackQuery', { callback_query_id: cbId, text: 'Something went wrong. Try again.' });
      return json({ ok: true });
    }
    if (!updated || !updated.length) {
      // Our update matched 0 rows: another surface (approve.html, or a second tap)
      // decided this first. Report the RECORDED verdict, never a false confirmation.
      const { data: fresh } = await supabase.from('purchase_requests').select('status').eq('token', parsed.token).maybeSingle();
      const st = fresh && fresh.status;
      await tg('answerCallbackQuery', { callback_query_id: cbId, text: st === 'approved' ? 'Already approved.' : st === 'rejected' ? 'Already rejected.' : 'Already decided.' });
      if (st === 'approved' || st === 'rejected') await collapseMessage(chatId, cq.message, st, row);
      else await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      return json({ ok: true });
    }
    await tg('answerCallbackQuery', { callback_query_id: cbId, text: parsed.verdict === 'approved' ? 'Approved' : 'Rejected' });
    // Collapse the full item list to a one-line summary and drop the buttons, so the
    // decided message is not a lingering wall of text.
    await collapseMessage(chatId, cq.message, parsed.verdict, row);
    return json({ ok: true });
  }

  return json({ ok: true });
});
