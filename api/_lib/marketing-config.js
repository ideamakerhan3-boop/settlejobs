// Brand identity for all outbound marketing/transactional comms.
//
// All values env-driven — to switch the sender email, brand name, or any
// social handle, set the corresponding env var on Vercel and redeploy.
// Defaults below are placeholders so code runs pre-config.
//
// HOW TO SWITCH SENDER EMAIL (when ready):
//   1. Vercel → Project → Settings → Environment Variables
//   2. Set BRAND_FROM_EMAIL = "noreply@canadayouthhire.ca" (or chosen address)
//   3. ALSO update the "From" field in EmailJS dashboard for the matching
//      service — EmailJS enforces sender at the service level, not per call.
//   4. Redeploy (any commit to main) — done.
//
// HOW TO ENABLE A SOCIAL CHANNEL:
//   1. Create the account (manual — Claude cannot create accounts)
//   2. Set BRAND_TWITTER / BRAND_INSTAGRAM / BRAND_LINKEDIN env var
//   3. Social content kit (admin endpoint) automatically includes the handle
//      in suggested post copy from the next deploy.

export const BRAND = {
  name:         process.env.BRAND_NAME           || 'YouthHire',
  tagline:      process.env.BRAND_TAGLINE        || "Canada's youth job board",
  baseUrl:      process.env.BRAND_BASE_URL       || 'https://www.canadayouthhire.ca',

  // EMAIL — sender identity. Hidden in EmailJS dashboard until configured.
  fromEmail:    process.env.BRAND_FROM_EMAIL     || '',     // empty = use EmailJS service default
  fromName:     process.env.BRAND_FROM_NAME      || 'YouthHire',
  replyTo:      process.env.BRAND_REPLY_TO       || '',
  supportEmail: process.env.BRAND_SUPPORT_EMAIL  || '',
  postalAddress: process.env.BRAND_POSTAL_ADDR   || '',     // CASL requires physical address in marketing emails

  // SOCIAL — set once accounts exist. Empty string = channel disabled.
  twitter:   process.env.BRAND_TWITTER   || '',  // e.g. 'youthhire_ca' (no @)
  instagram: process.env.BRAND_INSTAGRAM || '',  // e.g. 'youthhire.ca'
  linkedin:  process.env.BRAND_LINKEDIN  || '',  // company page URL
  facebook:  process.env.BRAND_FACEBOOK  || '',  // page URL
  tiktok:    process.env.BRAND_TIKTOK    || '',  // e.g. 'youthhire'
  reddit:    process.env.BRAND_REDDIT    || '',  // e.g. 'YouthHireCanada' subreddit
};

// EmailJS template IDs — point each comm type at its own template once
// designed in EmailJS dashboard. Until then, all fall back to the existing
// `template_welcome` (which has variables: subject/heading/message/button_text).
export const EMAIL_TEMPLATES = {
  welcome:        process.env.EMAILJS_TMPL_WELCOME    || 'template_welcome',
  passwordReset:  process.env.EMAILJS_TMPL_RESET      || 'template_welcome',
  jobAlert:       process.env.EMAILJS_TMPL_JOB_ALERT  || 'template_welcome',
  weeklyDigest:   process.env.EMAILJS_TMPL_WEEKLY     || 'template_welcome',
  expiryReminder: process.env.EMAILJS_TMPL_EXPIRY     || 'template_welcome',
  paymentReceipt: process.env.EMAILJS_TMPL_RECEIPT    || 'template_welcome',
};

/**
 * Build the standard footer block all marketing emails must include.
 * CASL requires (a) sender identification, (b) physical postal address,
 * (c) clear unsubscribe mechanism that works for at least 60 days.
 *
 * Pass the recipient's unsub_token; we render the unsubscribe URL.
 * Returns plain-text (good for `template_welcome` message field).
 */
export function buildMarketingFooter(unsubToken) {
  const lines = [
    '',
    '---',
    `${BRAND.name} — ${BRAND.tagline}`,
  ];
  if (BRAND.postalAddress) lines.push(BRAND.postalAddress);
  if (unsubToken) {
    lines.push('');
    lines.push('Unsubscribe from marketing emails:');
    lines.push(`${BRAND.baseUrl}/unsubscribe?t=${unsubToken}`);
  }
  return lines.join('\n');
}

/**
 * Transactional emails (welcome, reset, expiry, receipt) do NOT require
 * marketing opt-in and use a lighter footer (no unsubscribe — CASL exempts
 * transactional comms from opt-in but they still need sender identification).
 */
export function buildTransactionalFooter() {
  const lines = [
    '',
    '---',
    `${BRAND.name} — ${BRAND.tagline}`,
  ];
  if (BRAND.supportEmail) lines.push(`Questions? ${BRAND.supportEmail}`);
  return lines.join('\n');
}

/**
 * Detect whether a content type requires marketing opt-in.
 * Used by sendTransactionalEmail and the alert cron to gate sends.
 */
export function requiresMarketingOptIn(emailKind) {
  // CASL-compliant exemption list — these are recognized as transactional
  // ("implied consent" or pure response to user action) and do NOT require
  // express marketing opt-in.
  const TRANSACTIONAL = new Set([
    'welcome',
    'passwordReset',
    'paymentReceipt',
    'expiryReminder',  // sent to job-poster about their own job — implied consent
  ]);
  return !TRANSACTIONAL.has(emailKind);
}
