import { createClient } from '@supabase/supabase-js';
import { verifyAndUpgrade } from './_lib/verify.js';
import { notifyIndexNow } from './_lib/indexnow.js';

// Service key bypasses RLS. All admin operations gated by is_admin check.
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALLOWED_ORIGINS = [
  'https://www.canadayouthhire.ca',
  'https://canadayouthhire.ca',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/youthhire-[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function verifyAdmin(email, pw_hash) {
  if (!email || !pw_hash) return null;
  const em = email.toLowerCase();
  const { data: acct } = await sb.from('accounts')
    .select('email, pw, is_admin')
    .eq('email', em)
    .maybeSingle();
  if (!acct || !acct.is_admin) return null;
  const ok = await verifyAndUpgrade(sb, em, pw_hash, acct.pw);
  return ok ? acct : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { email, pw_hash, action } = body;

    const admin = await verifyAdmin(email, pw_hash);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    // ──────────────── LIST OPS ────────────────
    if (action === 'list_accounts') {
      // Never return pw field
      const { data } = await sb.from('accounts')
        .select('email, name, company, phone, is_admin, status, created_at')
        .order('created_at', { ascending: false });
      return res.status(200).json({ accounts: data || [] });
    }

    if (action === 'list_all_jobs') {
      const { data } = await sb.from('jobs').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ jobs: data || [] });
    }

    if (action === 'list_transactions') {
      const { data } = await sb.from('transactions').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ transactions: data || [] });
    }

    if (action === 'list_credits') {
      const { data } = await sb.from('credits').select('email, total, used, updated_at').order('updated_at', { ascending: false });
      return res.status(200).json({ credits: data || [] });
    }

    if (action === 'list_issue_jobs') {
      const { data } = await sb.from('issue_jobs').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ issue_jobs: data || [] });
    }

    if (action === 'list_promos') {
      const { data } = await sb.from('promo_codes').select('*').order('created_at', { ascending: false });
      return res.status(200).json({ promos: data || [] });
    }

    // ──────────────── ACCOUNT MGMT ────────────────
    if (action === 'set_account_status') {
      const { target_email, status } = body;
      if (!target_email || !['active','suspended'].includes(status)) return res.status(400).json({ error: 'bad input' });
      await sb.from('accounts').update({ status }).eq('email', target_email.toLowerCase());
      // If suspending, also close all their active jobs
      if (status === 'suspended') {
        await sb.from('jobs').update({ status: 'closed' }).eq('email', target_email.toLowerCase()).eq('status', 'active');
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── JOB MGMT (admin can change any job) ────────────────
    if (action === 'update_job_status') {
      const { job_id, status } = body;
      if (!job_id || !status) return res.status(400).json({ error: 'job_id and status required' });
      const { error } = await sb.from('jobs').update({ status }).eq('job_id', String(job_id));
      if (error) return res.status(500).json({ error: 'Update failed' });
      // Notify search engines when admin activates a job (fire-and-forget)
      if (status === 'active') {
        notifyIndexNow(String(job_id)).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── TRANSACTION MGMT ────────────────
    if (action === 'insert_transaction') {
      const { tx } = body;
      if (!tx) return res.status(400).json({ error: 'tx required' });
      const { data, error } = await sb.from('transactions').insert(tx).select();
      if (error) { console.error('insert_transaction:', error.message); return res.status(500).json({ error: error.message }); }
      return res.status(200).json({ transaction: data && data[0] });
    }

    if (action === 'update_transaction_status') {
      const { tx_id, ref, status, refunded_at } = body;
      if (!status) return res.status(400).json({ error: 'status required' });
      const patch = { status };
      if (refunded_at) patch.refunded_at = refunded_at;
      let q = sb.from('transactions').update(patch);
      if (tx_id) q = q.eq('id', tx_id);
      else if (ref) q = q.eq('ref', ref);
      else return res.status(400).json({ error: 'tx_id or ref required' });
      const { data, error } = await q.select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ transactions: data || [] });
    }

    // ──────────────── ISSUE JOBS (admin reports) ────────────────
    if (action === 'upsert_issue_job') {
      const { issue } = body;
      if (!issue) return res.status(400).json({ error: 'issue required' });
      const { data, error } = await sb.from('issue_jobs').upsert(issue).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ issue: data && data[0] });
    }

    if (action === 'update_issue_job_status') {
      const { id, status } = body;
      if (!id || !status) return res.status(400).json({ error: 'id and status required' });
      const { error } = await sb.from('issue_jobs').update({ status }).eq('id', String(id));
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── PROMO MGMT ────────────────
    if (action === 'create_promo') {
      const { promo } = body;
      if (!promo || !promo.code) return res.status(400).json({ error: 'promo with code required' });
      promo.code = promo.code.toUpperCase();
      const { data, error } = await sb.from('promo_codes').insert(promo).select();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ promo: data && data[0] });
    }

    if (action === 'toggle_promo') {
      const { id, is_active } = body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await sb.from('promo_codes').update({ is_active: !!is_active }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'update_promo_credits') {
      const { id, free_credits } = body;
      if (!id || typeof free_credits !== 'number') return res.status(400).json({ error: 'id and free_credits required' });
      const { error } = await sb.from('promo_codes').update({ free_credits }).eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── ADMIN SETTINGS ────────────────
    if (action === 'get_settings') {
      const { data } = await sb.from('admin_settings').select('*').eq('key', 'site_config').maybeSingle();
      return res.status(200).json({ settings: data || null });
    }

    if (action === 'upsert_settings') {
      const { settings } = body;
      if (!settings) return res.status(400).json({ error: 'settings required' });
      const { error } = await sb.from('admin_settings').upsert(settings, { onConflict: 'key' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── ADMIN DELETE ACCOUNT (for customer support) ────────────────
    if (action === 'delete_account') {
      const { target_email } = body;
      if (!target_email) return res.status(400).json({ error: 'target_email required' });
      const em = target_email.toLowerCase();
      await sb.from('jobs').update({ status: 'deleted' }).eq('email', em);
      const { error } = await sb.from('accounts').delete().eq('email', em);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── SOCIAL CONTENT GENERATOR (admin only) ────────────────
    // Returns ready-to-paste social posts for a given job. The owner copies
    // them into their (manually-managed) Twitter/LinkedIn/Reddit/Facebook
    // accounts. Per anthropic safety rules, we do NOT auto-post — that
    // requires platform credentials we don't have and may never have.
    //
    // Each format is hand-tuned for its platform:
    //   - twitter: 280 char cap, hashtag, emoji
    //   - linkedin: long-form, professional tone, 1300 char target
    //   - reddit: title + body, subreddit suggestion
    //   - facebook: casual, emoji, longer
    if (action === 'social_content') {
      const job_id = String(body.job_id || '').trim();
      if (!job_id) return res.status(400).json({ error: 'job_id required' });
      const { data: job } = await sb.from('jobs')
        .select('job_id, title, company, loc, prov, type, wage, category, remote, description, status')
        .eq('job_id', job_id).maybeSingle();
      if (!job) return res.status(404).json({ error: 'Job not found' });

      const BASE = 'https://www.canadayouthhire.ca';
      const url = `${BASE}/jobs/${job.job_id}`;
      const where = job.loc ? `${job.loc}${job.prov && !job.loc.endsWith(job.prov) ? ', ' + job.prov : ''}` : (job.prov || 'Canada');
      const remote = job.remote && /remote/i.test(job.remote);
      const wage = job.wage ? ` · ${job.wage}` : '';
      const tw_handle  = process.env.BRAND_TWITTER  ? '@' + process.env.BRAND_TWITTER : '@YouthHire';
      const ig_handle  = process.env.BRAND_INSTAGRAM ? '@' + process.env.BRAND_INSTAGRAM : '';
      const linkedin_pg = process.env.BRAND_LINKEDIN || '';

      // Twitter / X — 280 char hard cap
      const twTags = [
        '#YouthJobs', '#CanadaJobs',
        job.prov ? '#' + job.prov + 'Jobs' : '',
        remote ? '#RemoteJobs' : ''
      ].filter(Boolean).join(' ');
      let twitter = `🍁 ${job.title} at ${job.company}\n📍 ${where}${remote ? ' (Remote)' : ''}${wage}\n\n${url}\n\n${twTags}`;
      if (twitter.length > 280) {
        // Truncate title if needed
        const baseLen = twitter.length - job.title.length;
        const room = 280 - baseLen - 1;
        if (room > 10) {
          twitter = twitter.replace(job.title, job.title.substring(0, room) + '…');
        } else {
          twitter = `🍁 ${job.title.substring(0, 60)}\n${url}\n${twTags}`.substring(0, 280);
        }
      }

      // LinkedIn — long-form, professional
      const linkedin = `🇨🇦 New youth job opening in ${where}.\n\n` +
        `**${job.title}** — ${job.company}\n` +
        `${job.type ? '• ' + job.type + '\n' : ''}` +
        `${job.wage ? '• Compensation: ' + job.wage + '\n' : ''}` +
        `${job.category ? '• Field: ' + job.category + '\n' : ''}` +
        `${remote ? '• Remote-friendly\n' : ''}` +
        `\nWho is this for? Students, new grads, and young workers in Canada looking for entry-level or part-time work.\n\n` +
        `${(job.description || '').replace(/<[^>]+>/g,'').substring(0, 600)}${(job.description || '').length > 600 ? '…' : ''}\n\n` +
        `Apply or learn more on YouthHire (free job board for Canadian youth):\n${url}\n\n` +
        `#YouthEmployment #CanadaJobs ${job.prov ? '#' + job.prov : ''} #FirstJob #StudentJobs`;

      // Reddit — title + body, with subreddit suggestion
      const reddit_subreddit = job.prov === 'BC' ? 'r/vancouver or r/britishcolumbia'
                              : job.prov === 'ON' ? 'r/toronto or r/ontario'
                              : job.prov === 'AB' ? 'r/calgary or r/alberta'
                              : job.prov === 'QC' ? 'r/montreal or r/quebec'
                              : 'r/canada or r/jobs';
      const reddit_title = `[Hiring] ${job.title} - ${job.company} (${where})${wage}`;
      const reddit_body = `Hi ${reddit_subreddit.split(' ')[0]},\n\n` +
        `${job.company} is hiring a ${job.title} in ${where}.${remote ? ' This role is remote-friendly.' : ''}\n\n` +
        `**Quick details:**\n` +
        `${job.type ? '- Type: ' + job.type + '\n' : ''}` +
        `${job.wage ? '- Compensation: ' + job.wage + '\n' : ''}` +
        `${job.category ? '- Field: ' + job.category + '\n' : ''}` +
        `${job.exp_req && job.exp_req !== 'No experience' ? '- Experience: ' + job.exp_req + '\n' : '- Open to no-experience candidates\n'}` +
        `\nFull posting: ${url}\n\n` +
        `_(Posted on YouthHire — a free job board for Canadian students, new grads, and young workers. Mods, please remove if not allowed.)_`;
      const reddit = `**Subreddit suggestion:** ${reddit_subreddit}\n` +
        `**Read each subreddit's rules first** — many ban direct hiring posts and require flair.\n\n` +
        `**Title:**\n${reddit_title}\n\n` +
        `**Body:**\n${reddit_body}`;

      // Facebook — casual, emoji-heavy
      const facebook = `🌟 We've got a fresh youth job up on YouthHire!\n\n` +
        `📌 ${job.title}\n` +
        `🏢 ${job.company}\n` +
        `📍 ${where}${remote ? ' (Remote)' : ''}\n` +
        `${job.wage ? '💰 ' + job.wage + '\n' : ''}` +
        `${job.type ? '⏰ ' + job.type + '\n' : ''}` +
        `\nPerfect if you're a student, new grad, or just starting your career in Canada. ` +
        `Tag a friend who's job hunting! 👇\n\n` +
        `Apply here: ${url}`;

      return res.status(200).json({
        job_id:   job.job_id,
        title:    job.title,
        company:  job.company,
        url,
        social: {
          twitter:  { text: twitter,  char_count: twitter.length, char_limit: 280, handle: tw_handle },
          linkedin: { text: linkedin, char_count: linkedin.length, char_limit: 3000, page_url: linkedin_pg },
          reddit:   { text: reddit,   subreddit_suggestion: reddit_subreddit },
          facebook: { text: facebook, char_count: facebook.length },
        }
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('admin-api error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
