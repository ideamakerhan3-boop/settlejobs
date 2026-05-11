// Shared alert utilities for Twilio voice + email-to-SMS gateway.
// Used by: health-check.js, stripe-webhook.js
// (Email path now goes through Resend via _lib/email.js — same SMS gateway address.)

const ALERT_PHONE = process.env.ALERT_PHONE;
const ALERT_TO = process.env.ALERT_PHONE_EMAIL;

export async function sendVoiceCall(message) {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from || !ALERT_PHONE) { console.error('Twilio not configured'); return false; }
  const safe = String(message).replace(/[<>&]/g, ' ').substring(0, 200);
  const twiml = `<Response><Say voice="alice">${safe}</Say><Pause length="1"/><Say voice="alice">${safe}</Say></Response>`;
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: ALERT_PHONE, From: from, Twiml: twiml }).toString(),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error('Twilio call failed:', resp.status, txt);
      return false;
    }
    console.log('📞 Voice call placed');
    return true;
  } catch (e) { console.error('Twilio error:', e.message); return false; }
}

export async function sendSmsAlert(subject, body) {
  if (!ALERT_TO) { console.error('ALERT_PHONE_EMAIL not configured'); return false; }
  // Delegates to Resend-backed sendTransactionalEmail. Sends to the carrier
  // email-to-SMS gateway address; the carrier truncates to 140 chars so we
  // do the same here to make sure the meaningful part survives.
  const { sendTransactionalEmail } = await import('./email.js');
  const ok = await sendTransactionalEmail({
    template_id: 'sms_alert',
    template_params: {
      to_email: ALERT_TO,
      to_name:  'Admin',
      subject,
      heading:  subject,
      message:  (body || '').substring(0, 140),
    },
  });
  if (ok) console.log('📱 SMS alert sent:', subject);
  return ok;
}
