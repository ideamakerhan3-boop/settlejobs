import { createClient } from '@supabase/supabase-js';
import { purgeExpiredRateLimits } from './_lib/ratelimit.js';
import { sendMarketingEmail } from './_lib/email.js';
import { BRAND, EMAIL_TEMPLATES } from './_lib/marketing-config.js';
import { timingSafeEqual } from 'node:crypto';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Timing-safe comparison for "Bearer <secret>" auth header against env secret.
// Plain === leaks secret length via response time. crypto.timingSafeEqual
// requires equal-length buffers, so we early-exit on length mismatch.
function cronAuthOk(authHeader, expectedSecret) {
  if (!authHeader || !expectedSecret) return false;
  const expected = 'Bearer ' + expectedSecret;
  try {
    const a = Buffer.from(authHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch (_) { return false; }
}

// Accepts either human "Mon DD, YYYY" (legacy admin form output) or ISO
// "YYYY-MM-DD" (HTML <input type=date> default). Returns Date at local
// midnight on success, null on unparseable input. Defensive: future schema
// changes can swap format without breaking the expiry cron.
function parseExpDate(expStr) {
  if (!expStr) return null;
  try {
    var s = String(expStr).trim();
    // ISO YYYY-MM-DD or YYYY-MM-DDTHH... — verify components match the Date
    // (JS Date overflows month 13 → next-year January; reject explicitly).
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      var y = parseInt(iso[1]), m = parseInt(iso[2]) - 1, dd = parseInt(iso[3]);
      if (m < 0 || m > 11 || dd < 1 || dd > 31) return null;
      var d = new Date(y, m, dd);
      if (isNaN(d.getTime()) || d.getFullYear() !== y || d.getMonth() !== m || d.getDate() !== dd) return null;
      return d;
    }
    // Legacy human format: "Jul 1, 2026" or "Jul 1 2026"
    var parts = s.replace(',','').split(' ').filter(Boolean);
    if (parts.length < 3) return null;
    var mIdx = MONTHS.indexOf(parts[0]);
    if (mIdx < 0) return null;
    var d2 = new Date(parseInt(parts[2]), mIdx, parseInt(parts[1]));
    return isNaN(d2.getTime()) ? null : d2;
  } catch(e) { return null; }
}

// Delegates to the shared transactional sender (Resend under the hood).
// Adds a button URL so the rendered email has a clickable CTA to the dashboard.
async function sendExpiryEmail(toEmail, toName, jobTitle, expDate, daysLeft) {
  const { sendTransactionalEmail } = await import('./_lib/email.js');
  return sendTransactionalEmail({
    template_id: 'expiry_reminder',
    template_params: {
      to_email:    toEmail,
      to_name:     toName || toEmail,
      subject:     `Your job posting "${jobTitle}" expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      heading:     'Job Posting Expiring Soon',
      message:     `Your job posting "${jobTitle}" will expire on ${expDate}. If you'd like to keep it active, please renew it before the expiry date. Visit your dashboard to manage your postings.`,
      button_text: 'Go to Dashboard',
      button_url:  'https://www.canadayouthhire.ca/dashboard',
    },
  });
}

// Vercel Cron: 매일 14:00 UTC에 실행 (= 09:00 EST / 06:00 PST — Canadian morning)
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET is not configured');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  if (!cronAuthOk(req.headers.authorization, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Daily sweep of stale rate-limit rows (cheap, no index contention)
    await purgeExpiredRateLimits(sb).catch(function(e){ console.warn('rate_limits purge failed:', e.message); });

    const now = new Date();
    // Select only needed columns
    const { data: activeJobs, error } = await sb
      .from('jobs')
      .select('id, job_id, email, title, company, exp_date, notified_expiry')
      .eq('status', 'active');

    if (error) throw error;
    if (!activeJobs || activeJobs.length === 0) {
      return res.status(200).json({ message: 'No active jobs', expired: 0, notified: 0 });
    }

    // Separate expired vs needs-notification
    const toExpire = [];
    const toNotify = [];

    for (const job of activeJobs) {
      const expDate = parseExpDate(job.exp_date);
      if (!expDate) continue;

      if (expDate < now) {
        toExpire.push(job.id);
      } else if (!job.notified_expiry) {
        const daysLeft = Math.ceil((expDate.getTime() - now.getTime()) / 86400000);
        if (daysLeft <= 7 && daysLeft > 0) {
          toNotify.push({ ...job, daysLeft });
        }
      }
    }

    // Batch expire: single UPDATE for all expired jobs
    if (toExpire.length > 0) {
      await sb.from('jobs').update({ status: 'expired' }).in('id', toExpire);
    }

    // Parallel email sends with concurrency limit (max 5 at a time)
    let notified = 0;
    const CONCURRENCY = 5;
    for (let i = 0; i < toNotify.length; i += CONCURRENCY) {
      const batch = toNotify.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(job => sendExpiryEmail(
          job.email,
          job.company || job.email,
          job.title || 'Untitled',
          job.exp_date,
          job.daysLeft
        ))
      );

      // Mark notified for successful sends
      const successIds = [];
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value === true) {
          successIds.push(batch[j].id);
          notified++;
        }
        console.log(`📧 Expiry notice ${results[j].status === 'fulfilled' && results[j].value ? 'sent' : 'skipped'}: ${batch[j].title} → ${batch[j].email} (${batch[j].daysLeft}d left)`);
      }

      // Batch update notified flags
      if (successIds.length > 0) {
        await sb.from('jobs').update({ notified_expiry: true }).in('id', successIds);
      }
    }

    // ───────────────────────────────────────────────────────────────────
    // Job-alert digest — match active jobs to opted-in subscribers and send.
    // Runs in the same daily cron so we never need a second function slot.
    // Cron is 06:00 UTC = ~midnight in BC, 02:00 in ON; subscribers receive
    // a fresh digest before their morning. CASL-gated via sendMarketingEmail.
    // ───────────────────────────────────────────────────────────────────
    let alertsSent = 0;
    let alertsSkipped = 0;
    try {
      const { data: subscribers } = await sb.from('accounts')
        .select('email, name, marketing_opt_in, unsub_token, alert_prefs, last_alert_sent_at')
        .eq('marketing_opt_in', true)
        .neq('alert_prefs', '{}');

      if (subscribers && subscribers.length > 0) {
        for (const sub of subscribers) {
          const prefs = sub.alert_prefs || {};
          const freq = prefs.frequency === 'weekly' ? 'weekly' : 'daily';
          // Throttle per-account: daily = 22h min gap, weekly = 6.5d min gap
          const minGapMs = freq === 'weekly' ? 6.5 * 86400000 : 22 * 3600000;
          if (sub.last_alert_sent_at) {
            const ageMs = now.getTime() - new Date(sub.last_alert_sent_at).getTime();
            if (ageMs < minGapMs) { alertsSkipped++; continue; }
          }

          // Find matching active jobs created in the relevant window
          const windowMs = freq === 'weekly' ? 7 * 86400000 : 86400000 * 1.5; // a bit of slack
          const sinceISO = new Date(now.getTime() - windowMs).toISOString();
          let q = sb.from('jobs')
            .select('job_id, title, company, loc, prov, type, wage, category, remote, created_at')
            .eq('status', 'active')
            .gte('created_at', sinceISO)
            .order('created_at', { ascending: false })
            .limit(20);
          if (prefs.prov)     q = q.eq('prov', prefs.prov);
          if (prefs.category) q = q.eq('category', prefs.category);
          if (prefs.loc)      q = q.ilike('loc', `%${prefs.loc}%`);

          const { data: matches } = await q;
          if (!matches || matches.length === 0) { alertsSkipped++; continue; }

          // Build digest body — plaintext list of matched jobs with links.
          const lines = matches.slice(0, 10).map(j => {
            const where = j.loc ? `${j.loc}${j.prov ? ', ' + j.prov : ''}` : (j.prov || 'Canada');
            const wage = j.wage ? ` · ${j.wage}` : '';
            const remote = j.remote && /remote/i.test(j.remote) ? ' · 🏠 Remote' : '';
            return `• ${j.title} at ${j.company || 'Employer'} (${where}${wage}${remote})\n  ${BRAND.baseUrl}/jobs/${j.job_id}`;
          });
          const filterDesc = [
            prefs.prov && `province=${prefs.prov}`,
            prefs.category && `category=${prefs.category}`,
            prefs.loc && `near=${prefs.loc}`,
            prefs.remote_ok && 'remote OK'
          ].filter(Boolean).join(', ') || 'all openings';

          const result = await sendMarketingEmail({
            sb, account: sub,
            template_id: EMAIL_TEMPLATES.jobAlert,
            template_params: {
              subject:     `${matches.length} new youth ${matches.length === 1 ? 'job' : 'jobs'} matching your alert`,
              heading:     `New jobs for you on ${BRAND.name}`,
              message:     `Here are the ${matches.length} newest ${freq === 'weekly' ? 'this week' : 'today'} matching your alert (${filterDesc}):\n\n${lines.join('\n\n')}\n\nUpdate your alert settings:\n${BRAND.baseUrl}/dashboard`,
              button_text: 'Browse all jobs',
            }
          });

          if (result.sent) {
            await sb.from('accounts').update({ last_alert_sent_at: new Date().toISOString() }).eq('email', sub.email);
            alertsSent++;
          } else {
            alertsSkipped++;
          }
        }
      }
    } catch (alertErr) {
      console.error('job-alert sweep error (non-critical):', alertErr.message);
    }

    console.log(`Cron: expired ${toExpire.length}, notified ${notified}/${activeJobs.length} jobs, alerts sent ${alertsSent}, skipped ${alertsSkipped}`);
    return res.status(200).json({
      message: `Expired ${toExpire.length}, notified ${notified}, alerts ${alertsSent}/${alertsSent + alertsSkipped}`,
      expired: toExpire.length,
      notified,
      alerts_sent: alertsSent,
      alerts_skipped: alertsSkipped,
      total: activeJobs.length,
    });

  } catch (err) {
    console.error('Expire jobs error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
