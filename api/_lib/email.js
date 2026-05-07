// Server-side transactional email via the EmailJS REST API.
// Caller passes { template_params }; the helper supplies service/user/access creds
// from env vars (EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY).
//
// EMAILJS_SERVICE_ID must match an active service in the configured EmailJS
// account (currently `service_pbhgrg2` per project_youthhire_emailjs.md).
// Wrong service id surfaces as "[EMAILJS_FAIL] body=The service ID not found".
//
// Returns true on success, false on any failure (network, EmailJS error, missing
// config). Failures are logged but never thrown — callers can decide whether a
// missed email blocks their flow. For password reset specifically, we still
// succeed the user-facing request even if email send fails, to avoid leaking
// account existence via "email did/didn't send" signals.
//
// Two layers:
//   - sendTransactionalEmail — low-level, no consent gating. Use for welcome,
//     password reset, payment receipts, expiry reminders to the poster.
//   - sendMarketingEmail — high-level, gates on accounts.marketing_opt_in,
//     auto-appends CASL footer with unsubscribe URL, refuses to send to
//     accounts that haven't opted in. Use for job alerts, weekly digest,
//     promotional campaigns.

export async function sendTransactionalEmail({ template_id, template_params }) {
  const serviceId  = process.env.EMAILJS_SERVICE_ID;
  const publicKey  = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  const tmpl       = template_id || process.env.EMAILJS_TEMPLATE_GENERAL || 'template_welcome';

  if (!serviceId || !publicKey || !privateKey) {
    console.error('email: EMAILJS env vars not configured — skipping send');
    return false;
  }
  if (!template_params || !template_params.to_email) {
    console.error('email: template_params.to_email required');
    return false;
  }

  // Cap the EmailJS call so a slow EmailJS upstream doesn't burn our 10s
  // function-timeout budget (saw 504s in production when EmailJS hung >10s).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: tmpl,
        user_id: publicKey,
        accessToken: privateKey,
        template_params,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // Combine status + body + meta into ONE console.error call. Vercel's log
      // table view shows the first stderr line per request; multiple errors
      // get collapsed. Single-line keeps the rejection reason visible.
      const flat = (body || '').substring(0, 400).replace(/\s+/g, ' ');
      console.error('[EMAILJS_FAIL] status=' + resp.status + ' tmpl=' + tmpl + ' to=' + template_params.to_email + ' body=' + flat);
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(timeoutId);
    const reason = e.name === 'AbortError' ? 'timeout_6s' : (e.message || 'unknown');
    console.error('[EMAILJS_FAIL] fetch_error=' + reason + ' tmpl=' + tmpl + ' to=' + template_params.to_email);
    return false;
  }
}

/**
 * High-level marketing email sender — CASL-gated and unsubscribe-equipped.
 *
 * Required: { sb, account, template_id, template_params }
 *   - sb            Supabase service-role client (caller passes their own)
 *   - account       Either { email } (we'll look up the rest) OR a full row
 *                   with { email, marketing_opt_in, unsub_token, name }
 *   - template_id   EmailJS template (typically EMAIL_TEMPLATES.jobAlert etc.)
 *   - template_params Standard EmailJS shape; we'll inject CASL footer into
 *                   `message` and ensure to_email/to_name are set from account.
 *
 * Returns one of:
 *   { sent: true }
 *   { sent: false, reason: 'no_optin' | 'no_account' | 'send_failed' }
 *
 * Refuses to send if:
 *   - account.marketing_opt_in !== true (CASL violation)
 *   - account.unsub_token missing (no way to honor unsubscribe)
 */
export async function sendMarketingEmail({ sb, account, template_id, template_params }) {
  const { buildMarketingFooter } = await import('./marketing-config.js');

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

  // Inject CASL footer into the message body. template_welcome's message
  // field is plain text — append a separator + footer.
  const params = { ...template_params };
  params.to_email = acct.email;
  params.to_name  = acct.name || acct.email;
  params.message  = (params.message || '') + buildMarketingFooter(acct.unsub_token);

  const ok = await sendTransactionalEmail({ template_id, template_params: params });
  return { sent: !!ok, reason: ok ? null : 'send_failed' };
}
