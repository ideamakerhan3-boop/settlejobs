// ╔══════════════════════════════════════════════════════════════════════╗
// ║  ⚠️  WORKING TRANSACTIONAL EMAIL PATH — DO NOT REMOVE WITHOUT THESE   ║
// ║      THREE STEPS, IN ORDER.                                          ║
// ║                                                                      ║
// ║  Incident history that motivates this banner:                        ║
// ║    PR #51 (2026-05-10) ripped out the prior EmailJS path before     ║
// ║    RESEND_API_KEY was set on Vercel → 30 min of zero email sends.   ║
// ║    PR #52 reverted. PR #54 re-applied correctly after env-first +   ║
// ║    test-send verification.                                           ║
// ║    PR #57 (2026-05-11) fixed a `*/` inside this file's JSDoc that    ║
// ║    closed the comment early — esbuild bundled it but the first       ║
// ║    runtime call threw `SyntaxError`. auth-api's try/catch swallowed  ║
// ║    the error and returned ok:true, masking another 30 min of zero   ║
// ║    sends. PR #61 added `.github/workflows/pr-syntax-check.yml` to    ║
// ║    block that class of regression at PR time via `node --check`.    ║
// ║                                                                      ║
// ║  Before swapping THIS Resend path for another provider:              ║
// ║    1. Confirm new provider env vars are set on Vercel (curl API).    ║
// ║    2. Test-send via the new provider and confirm delivery + From.    ║
// ║    3. Use a feature flag (EMAIL_PROVIDER) to keep this path callable ║
// ║       as a fallback for a few days. Never delete in the same PR as   ║
// ║       the new path lands.                                            ║
// ║                                                                      ║
// ║  Full rationale: memory/lesson_youthhire_data_safety_patterns.md §6+§7║
// ║                  Cortex/wiki/lessons/email-provider-migration-safety.md ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// Server-side transactional email via the Resend REST API.
// From address is BRAND_FROM_EMAIL on a Resend-verified domain (DKIM-signed).
//
// Required env vars:
//   RESEND_API_KEY    — Resend secret API key (server-only, never expose)
//   BRAND_FROM_EMAIL  — info@canadayouthhire.ca (must be on a Resend-verified domain)
//   BRAND_FROM_NAME   — "Canada Youth Hire" (default if unset)
// Optional:
//   BRAND_REPLY_TO    — reply-to address (defaults to BRAND_FROM_EMAIL)
//
// MIGRATION NOTE (2026-05-10): Migrated from EmailJS. The EmailJS Gmail
// service ALWAYS uses the connected Gmail OAuth account's primary email as
// the From header — alias/sender override is not supported on Gmail-type
// services. That meant our transactional mail was going out from a personal
// Gmail (`ideamakerhan4@gmail.com`) regardless of any "Send mail as" alias
// the operator had set up. Resend instead signs with the verified domain's
// DKIM key, so `info@canadayouthhire.ca` shows up as the authentic sender.
//
// Returns true on success, false on any failure. Failures are logged but
// never thrown so callers can decide whether a missed email blocks their
// flow. For password reset specifically, we still return generic success to
// the user even if send fails — that prevents account-existence leaks via
// "did/didn't get email" oracles.
//
// Two layers:
//   - sendTransactionalEmail — low-level, no consent gating. Use for welcome,
//     password reset, payment receipts, expiry reminders to the poster.
//   - sendMarketingEmail — high-level, gates on accounts.marketing_opt_in,
//     auto-appends CASL footer with unsubscribe URL, refuses to send to
//     accounts that haven't opted in. Use for job alerts, weekly digest,
//     promotional campaigns.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export async function sendTransactionalEmail({ template_id, template_params }) {
  const apiKey   = process.env.RESEND_API_KEY;
  const fromAddr = process.env.BRAND_FROM_EMAIL;
  const fromName = process.env.BRAND_FROM_NAME || 'Canada Youth Hire';
  const replyTo  = process.env.BRAND_REPLY_TO || fromAddr;

  if (!apiKey) {
    console.error('email: RESEND_API_KEY not configured — skipping send');
    return false;
  }
  if (!fromAddr) {
    console.error('email: BRAND_FROM_EMAIL not configured — skipping send');
    return false;
  }
  if (!template_params || !template_params.to_email) {
    console.error('email: template_params.to_email required');
    return false;
  }

  const subject = template_params.subject || 'Canada Youth Hire';
  const html = renderTemplate(template_params);

  // 6s upstream cap so a slow Resend call doesn't burn our 10s function budget.
  // (Resend is typically <1s but historic EmailJS spikes >10s caused 504s.)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromName + ' <' + fromAddr + '>',
        to: [template_params.to_email],
        reply_to: replyTo,
        subject: subject,
        html: html,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // Single-line log: Vercel collapses multi-line stderr per request.
      const flat = (body || '').substring(0, 400).replace(/\s+/g, ' ');
      console.error('[RESEND_FAIL] status=' + resp.status + ' tmpl=' + (template_id || 'default') + ' to=' + template_params.to_email + ' body=' + flat);
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(timeoutId);
    const reason = e.name === 'AbortError' ? 'timeout_6s' : (e.message || 'unknown');
    console.error('[RESEND_FAIL] fetch_error=' + reason + ' tmpl=' + (template_id || 'default') + ' to=' + template_params.to_email);
    return false;
  }
}

// Minimal HTML escaper. All caller-supplied strings (name, message, subject,
// company) pass through here before going into the rendered HTML.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http/https/mailto URLs in buttons — blocks javascript: etc.
function escUrl(s) {
  const v = String(s == null ? '' : s).trim();
  if (!/^(https?:\/\/|mailto:)/i.test(v)) return '';
  return v.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
}

// Render unified HTML body from template_params. Backward-compatible with the
// old EmailJS `template_welcome` variable shape: subject, heading, message,
// button_text (+ optional button_url) and `template_reset`'s tmp_password.
// Embedded URLs in `message` stay plain text — callers that need a clickable
// CTA should pass button_url separately.
function renderTemplate(p) {
  const heading = esc(p.heading || p.subject || 'Canada Youth Hire');
  const name = esc(p.to_name || '').trim();
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const message = p.message ? esc(p.message) : '';
  // Preserve line breaks from the original plain-text message.
  const messageHtml = message
    ? message.split('\n').map(line => line.trim() ? `<p style="margin:0 0 16px 0;line-height:1.5;">${line}</p>` : '').join('')
    : '';

  let extra = '';
  if (p.tmp_password) {
    extra += `<p style="margin:24px 0 8px 0;">Your temporary password:</p>` +
      `<p style="font-family:Menlo,Monaco,Consolas,monospace;font-size:20px;background:#f6f8fa;padding:16px;border-radius:6px;margin:0 0 16px 0;letter-spacing:1px;border:1px solid #d0d7de;">${esc(p.tmp_password)}</p>` +
      `<p style="color:#555;font-size:13px;margin:0 0 16px 0;">Please log in and change this password from your account settings.</p>`;
  }

  if (p.button_text && p.button_url) {
    const url = escUrl(p.button_url);
    if (url) {
      extra += `<p style="margin:24px 0;"><a href="${url}" style="display:inline-block;background:#1f6feb;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">${esc(p.button_text)}</a></p>`;
    }
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2328;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;padding:32px 16px;">` +
    `<tr><td align="center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;padding:32px;">` +
    `<tr><td>` +
    `<h1 style="margin:0 0 16px 0;font-size:22px;color:#1f2328;">${heading}</h1>` +
    `<p style="margin:0 0 16px 0;color:#1f2328;">${greeting}</p>` +
    messageHtml +
    extra +
    `<hr style="margin:32px 0 16px 0;border:none;border-top:1px solid #d0d7de;">` +
    `<p style="margin:0;color:#656d76;font-size:13px;">Canada Youth Hire team<br>` +
    `<a href="https://www.canadayouthhire.ca" style="color:#1f6feb;text-decoration:none;">canadayouthhire.ca</a></p>` +
    `</td></tr></table>` +
    `</td></tr></table>` +
    `</body></html>`;
}

/**
 * High-level marketing email sender — CASL-gated and unsubscribe-equipped.
 *
 * Required: { sb, account, template_id, template_params }
 *   - sb            Supabase service-role client (caller passes their own)
 *   - account       Either { email } (we'll look up the rest) OR a full row
 *                   with { email, marketing_opt_in, unsub_token, name }
 *   - template_id   Semantic label only (e.g. 'jobAlert') — used for logs.
 *   - template_params Standard shape (subject, heading, message, button_text,
 *                   button_url, to_email, to_name); we'll inject CASL footer
 *                   into `message` and ensure to_email/to_name are set from
 *                   account.
 *
 * Returns one of:
 *   { sent: true }
 *   { sent: false, reason: 'no_optin' | 'no_account' | 'send_failed' | ... }
 *
 * Refuses to send if:
 *   - account.marketing_opt_in !== true (CASL violation)
 *   - account.unsub_token missing (no way to honor unsubscribe)
 */
export async function sendMarketingEmail({ sb, account, template_id, template_params }) {
  const { buildMarketingFooter, BRAND } = await import('./marketing-config.js');

  // Sender-config guard: refuse to send marketing if BRAND_FROM_EMAIL is empty.
  // Without this, the helper would still try Resend with an empty From which
  // returns 422. Fail loud, not silent — CASL requires explicit sender ID.
  if (!BRAND.fromEmail) {
    console.error('[MARKETING_BLOCKED] BRAND_FROM_EMAIL env var is empty — refusing to send marketing email. Set it on Vercel and redeploy.');
    return { sent: false, reason: 'sender_not_configured' };
  }
  if (!BRAND.postalAddress) {
    // CASL also requires a physical postal address in marketing emails.
    console.error('[MARKETING_BLOCKED] BRAND_POSTAL_ADDR env var is empty — CASL requires a physical address in marketing emails. Set it on Vercel and redeploy.');
    return { sent: false, reason: 'postal_address_missing' };
  }

  // Hydrate account if only email given
  let acct = account;
  if (acct && !acct.unsub_token) {
    const { data } = await sb.from('accounts')
      .select('email, name, marketing_opt_in, unsub_token')
      .eq('email', acct.email)
      .maybeSingle();
    if (!data) return { sent: false, reason: 'no_account' };
    acct = data;
  }

  if (!acct.marketing_opt_in) return { sent: false, reason: 'no_optin' };
  if (!acct.unsub_token)      return { sent: false, reason: 'no_unsub_token' };

  // Append CASL footer to the message body. renderTemplate preserves newlines.
  const params = { ...template_params };
  params.to_email = acct.email;
  params.to_name  = acct.name || acct.email;
  params.message  = (params.message || '') + buildMarketingFooter(acct.unsub_token);

  const ok = await sendTransactionalEmail({ template_id, template_params: params });
  return { sent: !!ok, reason: ok ? null : 'send_failed' };
}
