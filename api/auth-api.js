import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { rateLimit } from './_lib/ratelimit.js';
import { verifyTurnstile } from './_lib/turnstile.js';
import { notifyIndexNow, notifyIndexNowJob } from './_lib/indexnow.js';

// 32-char hex (128 bits) — used for unsub_token and password reset tokens.
function cryptoRandomHex32() {
  return randomBytes(16).toString('hex');
}

// Service key bypasses RLS — all sensitive account/job operations go through here.
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BCRYPT_ROUNDS = 12;
const BCRYPT_PREFIX = '$2'; // bcrypt hashes start with $2a / $2b / $2y

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

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return (Array.isArray(xff) ? xff[0] : xff.split(',')[0]).trim() || req.socket?.remoteAddress || 'unknown';
}

// Verify account credentials, returns account row or null.
// Supports both legacy unsalted SHA-256 (from pre-bcrypt users) and bcrypt.
// On successful legacy login, transparently upgrades stored hash to bcrypt.
async function verifyAuth(email, pw_hash) {
  if (!email || !pw_hash) return null;
  const { data: acct } = await sb.from('accounts')
    .select('email, pw, name, company, is_admin, status')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (!acct) return null;
  let ok = false;
  if (acct.pw && acct.pw.startsWith(BCRYPT_PREFIX)) {
    ok = await bcrypt.compare(pw_hash, acct.pw);
  } else if (acct.pw === pw_hash) {
    // Legacy plain SHA-256 match — upgrade to bcrypt on-the-fly
    ok = true;
    try {
      const upgraded = await bcrypt.hash(pw_hash, BCRYPT_ROUNDS);
      await sb.from('accounts').update({ pw: upgraded }).eq('email', acct.email);
    } catch (e) {
      console.error('bcrypt upgrade failed for', acct.email, e.message);
    }
  }
  return ok ? acct : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = req.body || {};
    const { action } = body;
    const ip = clientIp(req);

    // ──────────────── REGISTER (no prior auth) ────────────────
    if (action === 'register') {
      // Honeypot: legitimate registrations never set these fields.
      // Naive bots auto-fill any field named website/url/homepage/phone_number.
      // If set, silently succeed (200) so bots think they passed — no DB write, no alert leak.
      if (body.website || body.url || body.homepage || body.phone_number) {
        console.warn('honeypot tripped from IP', ip);
        return res.status(200).json({ ok: true, email: 'silent@honeypot', name: '', company: '', is_admin: false });
      }
      // Turnstile CAPTCHA: when client sends turnstile_token, verify with Cloudflare.
      // Backwards-compatible: if client hasn't been updated yet (no token), the
      // helper returns true when TURNSTILE_SECRET_KEY is set but token missing
      // we fail closed. Client-side integration comes in a separate pass.
      if (body.turnstile_token !== undefined) {
        const ok = await verifyTurnstile(body.turnstile_token, ip);
        if (!ok) return res.status(403).json({ error: 'Bot check failed. Please refresh and try again.' });
      }
      const { email, pw_hash, name, company, marketing_opt_in } = body;
      if (!email || !pw_hash) return res.status(400).json({ error: 'email and pw_hash required' });
      if (!/^[a-f0-9]{64}$/.test(pw_hash)) return res.status(400).json({ error: 'invalid pw_hash format' });
      // Input length hard caps (defense against oversized payloads)
      if (email.length > 254) return res.status(400).json({ error: 'email too long' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email format' });
      if (name && String(name).length > 120) return res.status(400).json({ error: 'name too long' });
      if (company && String(company).length > 160) return res.status(400).json({ error: 'company too long' });
      // Rate limit: 5 registrations per IP per 10 min (Supabase-backed, durable)
      if (!(await rateLimit(sb, 'reg:' + ip, 5, 600_000))) {
        return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
      }
      const em = email.toLowerCase();

      // Check if already exists
      const { data: existing } = await sb.from('accounts').select('email, is_admin').eq('email', em).maybeSingle();
      if (existing) {
        return res.status(409).json({ error: 'Account already exists with this email' });
      }

      // Insert new account with bcrypt-hashed password (salt is embedded).
      // CASL marketing opt-in is captured here from a checkbox on the signup form.
      // The unsub_token defaults to a fresh UUID via Postgres so unsubscribe URLs
      // work even if the user opts in later from settings.
      const hashedPw = await bcrypt.hash(pw_hash, BCRYPT_ROUNDS);
      const optedIn = marketing_opt_in === true;  // strict boolean — checkbox values
      const { error: insErr } = await sb.from('accounts').insert({
        email: em, pw: hashedPw, name: name || '', company: company || '', is_admin: false, status: 'active',
        created_at: new Date().toISOString(),
        marketing_opt_in: optedIn,
        marketing_opt_in_at: optedIn ? new Date().toISOString() : null,
        unsub_token: cryptoRandomHex32(),
      });
      if (insErr) {
        console.error('register insert error:', insErr.message);
        return res.status(500).json({ error: 'Failed to create account' });
      }

      // Grant 5 free signup credits atomically. transactions.ref has a UNIQUE
      // constraint on 'SIGNUP-<email>' so this is idempotent — the legacy
      // /api/credits-api signup_bonus path stays as a defensive recovery and
      // won't double-grant.
      let signupTotal = 0, signupUsed = 0;
      try {
        const { error: txErr } = await sb.from('transactions').insert({
          email: em, pkg: 'Welcome 5 Credits', credits: 5,
          method: 'free', status: 'paid', amount: '0',
          ref: 'SIGNUP-' + em, created_at: new Date().toISOString()
        });
        if (!txErr) {
          // First-time grant — account is brand new so no concurrent credit writers.
          await sb.from('credits').upsert(
            { email: em, total: 5, used: 0, updated_at: new Date().toISOString() },
            { onConflict: 'email' }
          );
          signupTotal = 5;
        } else {
          // SIGNUP tx already existed (recovery path) — just read current state.
          const { data: cr } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
          signupTotal = cr?.total || 0;
          signupUsed = cr?.used || 0;
        }
      } catch (e) {
        console.error('register: signup credit grant failed for', em, e.message);
        // Account exists but credits not granted. Client's existing signup_bonus
        // call recovers. Don't block register.
      }

      // Send welcome email server-side via Resend. Migrated from client-side
      // EmailJS (browser SDK) so the From header is the verified brand domain
      // (info@canadayouthhire.ca) instead of an operator's personal Gmail.
      // Failure is non-fatal — registration still succeeds.
      try {
        const { sendTransactionalEmail } = await import('./_lib/email.js');
        await sendTransactionalEmail({
          template_id: 'welcome',
          template_params: {
            to_email:    em,
            to_name:     name || em,
            subject:     'Welcome to Canada Youth Hire, ' + (name || em) + '!',
            heading:     'Welcome to Canada Youth Hire!',
            message:     'Your account for ' + (company || 'your company') + ' has been created successfully. ' + (signupTotal > 0 ? signupTotal + ' free job posting credit(s) have been added to your account. ' : '') + 'You can now post jobs and connect with young job seekers across Canada.',
            button_text: 'Go to Dashboard',
            button_url:  'https://www.canadayouthhire.ca/dashboard',
          },
        });
      } catch (e) {
        console.error('register: welcome email send failed for', em, e.message);
      }

      return res.status(200).json({
        ok: true, email: em, name: name || '', company: company || '', is_admin: false,
        credits: { total: signupTotal, used: signupUsed }
      });
    }

    // ──────────────── ADMIN LOGIN BY PW ONLY (legacy 6-logo-click flow) ────────────────
    // Accepts just pw_hash, finds any admin account that matches.
    // Rate-limited by Vercel. Logs attempts server-side for audit.
    if (action === 'admin_login_by_pw_only') {
      const { pw_hash } = body;
      if (!pw_hash || !/^[a-f0-9]{64}$/.test(pw_hash)) {
        return res.status(400).json({ error: 'pw_hash required (64-char hex)' });
      }
      // Rate limit: 5 attempts per IP per 10 min (admin is highest value target)
      if (!(await rateLimit(sb, 'adminpw:' + ip, 5, 600_000))) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      const { data: admins } = await sb.from('accounts')
        .select('email, name, company, pw')
        .eq('is_admin', true);
      let match = null;
      for (const a of (admins || [])) {
        if (a.pw && a.pw.startsWith(BCRYPT_PREFIX)) {
          if (await bcrypt.compare(pw_hash, a.pw)) { match = a; break; }
        } else if (a.pw === pw_hash) {
          match = a;
          // Upgrade legacy admin hash
          try {
            const upgraded = await bcrypt.hash(pw_hash, BCRYPT_ROUNDS);
            await sb.from('accounts').update({ pw: upgraded }).eq('email', a.email);
          } catch (e) { console.error('admin bcrypt upgrade failed:', e.message); }
          break;
        }
      }
      if (!match) {
        console.warn('admin_login_by_pw_only: no match');
        return res.status(403).json({ error: 'Incorrect admin password' });
      }
      console.log('admin_login_by_pw_only success:', match.email);
      return res.status(200).json({
        email: match.email, name: match.name, company: match.company, is_admin: true, pw_hash: pw_hash
      });
    }

    // ──────────────── LOGIN (verify creds, return profile) ────────────────
    if (action === 'login') {
      const { email, pw_hash } = body;
      // Rate limit: 10 attempts per IP+email per 10 min
      if (!(await rateLimit(sb, 'login:' + ip + ':' + (email || '').toLowerCase(), 10, 600_000))) {
        return res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
      }
      const acct = await verifyAuth(email, pw_hash);
      if (!acct) return res.status(403).json({ error: 'Invalid credentials' });
      if (acct.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
      return res.status(200).json({
        email: acct.email, name: acct.name, company: acct.company, is_admin: !!acct.is_admin
      });
    }

    // ──────────────── REQUEST_RESET (no auth) — generate token, email link ────────────────
    if (action === 'request_reset') {
      const rawEmail = body.email;
      if (!rawEmail || typeof rawEmail !== 'string') return res.status(400).json({ error: 'email required' });
      const em = rawEmail.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 254) {
        return res.status(400).json({ error: 'invalid email' });
      }
      // Rate limits: stricter than login because compromised reset = takeover.
      // 3 per email/hour blunts targeted harassment; 5 per IP/hour blunts enumeration sweeps.
      if (!(await rateLimit(sb, 'reset_email:' + em, 3, 3600_000))) {
        return res.status(429).json({ error: 'Too many reset requests for this email. Try again in an hour.' });
      }
      if (!(await rateLimit(sb, 'reset_ip:' + ip, 5, 3600_000))) {
        return res.status(429).json({ error: 'Too many reset requests. Try again in an hour.' });
      }

      // Always return a generic success regardless of whether the email matches an
      // account (prevents enumeration). Only do the work if the account exists.
      const { data: acct } = await sb.from('accounts').select('email, name, status').eq('email', em).maybeSingle();
      if (acct && acct.status !== 'suspended') {
        try {
          const crypto = await import('node:crypto');
          const token = crypto.randomBytes(32).toString('hex'); // 64-char URL-safe
          const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
          const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1h
          await sb.from('accounts').update({
            reset_token_hash: tokenHash,
            reset_token_expires_at: expiresAt,
          }).eq('email', acct.email);

          const resetUrl = 'https://www.canadayouthhire.ca/reset?token=' + token;
          const { sendTransactionalEmail } = await import('./_lib/email.js');
          await sendTransactionalEmail({
            template_id: process.env.EMAILJS_TEMPLATE_GENERAL || 'template_welcome',
            template_params: {
              to_email: acct.email,
              to_name: acct.name || acct.email,
              subject: 'Reset your YouthHire password',
              heading: 'Password Reset Requested',
              message:
                'Click the link below to choose a new password. The link expires in 1 hour.\n\n' +
                resetUrl + '\n\n' +
                'If you did not request this, you can safely ignore this email — your password will not change.',
              button_text: 'Reset Password',
            },
          });
        } catch (e) {
          // Log but do not surface — generic success keeps email enumeration shut.
          console.error('request_reset internal error:', e.message);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── VERIFY_RESET (token-based, sets new password) ────────────────
    if (action === 'verify_reset') {
      const { token, new_pw_hash } = body;
      if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        return res.status(400).json({ error: 'invalid token' });
      }
      if (!new_pw_hash || !/^[a-f0-9]{64}$/.test(new_pw_hash)) {
        return res.status(400).json({ error: 'invalid new password' });
      }
      // Rate limit per IP — slows offline-style token guessing if anything leaks.
      if (!(await rateLimit(sb, 'reset_verify:' + ip, 10, 3600_000))) {
        return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
      }
      const crypto = await import('node:crypto');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const { data: acct } = await sb.from('accounts')
        .select('email, reset_token_hash, reset_token_expires_at, status')
        .eq('reset_token_hash', tokenHash)
        .maybeSingle();
      if (!acct) return res.status(403).json({ error: 'Invalid or expired reset link' });
      if (!acct.reset_token_expires_at || new Date(acct.reset_token_expires_at) < new Date()) {
        return res.status(403).json({ error: 'Reset link expired. Please request a new one.' });
      }
      if (acct.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

      const newHashed = await bcrypt.hash(new_pw_hash, BCRYPT_ROUNDS);
      const { error: updErr } = await sb.from('accounts').update({
        pw: newHashed,
        reset_token_hash: null,
        reset_token_expires_at: null,
      }).eq('email', acct.email);
      if (updErr) {
        console.error('verify_reset update error:', updErr.message);
        return res.status(500).json({ error: 'Could not update password. Try again.' });
      }
      return res.status(200).json({ ok: true, email: acct.email });
    }

    // ──────────────── TRACK_EVENT (anonymous accepted) ────────────────
    // Self-hosted analytics. No auth required (page views from logged-out
    // visitors). Strict whitelist of event types + length caps prevent abuse.
    // Rate-limited per IP to deter flood bombing the events table.
    if (action === 'track_event') {
      const ALLOWED_TYPES = new Set([
        'pageview', 'job_view', 'job_apply_click', 'signup_start',
        'signup_complete', 'login', 'post_job_start', 'post_job_complete',
        'alert_optin', 'alert_save', 'unsubscribe', 'feed_click',
        'social_share', 'cta_click'
      ]);
      const t = String(body.event_type || '').slice(0, 40);
      if (!ALLOWED_TYPES.has(t)) {
        // Silent no-op for unknown types — don't 400 to keep client tracker
        // resilient if ALLOWED_TYPES is updated server-side first.
        return res.status(200).json({ ok: true, ignored: true });
      }
      // Rate limit per IP — 100 events / 5min, generous enough for any real
      // user but blocks bots from filling the table.
      if (!(await rateLimit(sb, 'evt:' + ip, 100, 300_000))) {
        return res.status(200).json({ ok: true, throttled: true });
      }
      const cap = (s, n) => (s ? String(s).slice(0, n) : null);
      try {
        await sb.from('events').insert({
          event_type:    t,
          page:          cap(body.page, 200),
          session_id:    cap(body.session_id, 32),
          email:         body.email ? String(body.email).toLowerCase().slice(0, 254) : null,
          referrer_host: cap(body.referrer_host, 80),
          utm_source:    cap(body.utm_source, 60),
          utm_medium:    cap(body.utm_medium, 60),
          utm_campaign:  cap(body.utm_campaign, 80),
          meta:          (body.meta && typeof body.meta === 'object') ? body.meta : {}
        });
      } catch (e) {
        // Never surface insert errors — analytics must never break the app
        console.warn('track_event insert failed (non-critical):', e.message);
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── LOG_ERROR (anonymous accepted) ────────────────
    // Client-side window.onerror / unhandledrejection capture. Truncates
    // payloads to prevent log-bomb attacks. Same per-IP rate limit as events.
    if (action === 'log_error') {
      if (!(await rateLimit(sb, 'err:' + ip, 50, 300_000))) {
        return res.status(200).json({ ok: true, throttled: true });
      }
      const cap = (s, n) => (s ? String(s).slice(0, n) : null);
      try {
        await sb.from('error_logs').insert({
          message:    cap(body.message, 500) || 'unknown',
          source:     cap(body.source, 300),
          line_no:    typeof body.line_no === 'number' ? body.line_no : null,
          col_no:     typeof body.col_no === 'number' ? body.col_no : null,
          stack:      cap(body.stack, 2000),
          page:       cap(body.page, 200),
          user_agent: cap(body.user_agent, 300),
          email:      body.email ? String(body.email).toLowerCase().slice(0, 254) : null,
        });
      } catch (e) {
        console.warn('log_error insert failed (non-critical):', e.message);
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── UNSUBSCRIBE (token-based, no auth needed) ────────────────
    // Unsub URL format: /unsubscribe?t=<unsub_token>
    // Token is per-account, stable across sessions, generated at registration
    // (or backfilled via migration). Flips marketing_opt_in to false and clears
    // last_alert_sent_at so re-opt-in starts fresh. Always returns ok=true even
    // for unknown tokens to avoid leaking which tokens are valid.
    if (action === 'unsubscribe') {
      const { token } = body;
      if (!token || typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
        // Don't 400 — return ok to avoid token-validity oracle
        return res.status(200).json({ ok: true });
      }
      try {
        await sb.from('accounts').update({
          marketing_opt_in: false,
          last_alert_sent_at: null,
        }).eq('unsub_token', token);
      } catch (e) {
        console.error('unsubscribe error:', e.message);
      }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── All below require auth ────────────────
    const { email, pw_hash } = body;
    const acct = await verifyAuth(email, pw_hash);
    if (!acct) return res.status(403).json({ error: 'Invalid credentials' });
    const em = acct.email;
    const isAdmin = !!acct.is_admin;

    // ──────────────── GET_PROFILE ────────────────
    if (action === 'get_profile') {
      const { data: full } = await sb.from('accounts')
        .select('email, name, company, phone, is_admin, status, created_at')
        .eq('email', em).maybeSingle();
      return res.status(200).json(full || {});
    }

    // ──────────────── UPDATE_PROFILE (name/company/phone + optional new pw) ────────────────
    if (action === 'update_profile') {
      const { name, company, phone, new_pw_hash } = body;
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (company !== undefined) patch.company = company;
      if (phone !== undefined) patch.phone = phone;
      if (new_pw_hash) {
        if (!/^[a-f0-9]{64}$/.test(new_pw_hash)) return res.status(400).json({ error: 'invalid new_pw_hash' });
        patch.pw = await bcrypt.hash(new_pw_hash, BCRYPT_ROUNDS);
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });
      const { error } = await sb.from('accounts').update(patch).eq('email', em);
      if (error) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── DELETE_ACCOUNT (soft: mark jobs deleted, hard-delete account row) ────────────────
    if (action === 'delete_account') {
      // Mark all user's jobs as deleted first
      await sb.from('jobs').update({ status: 'deleted' }).eq('email', em);
      // Then delete account
      const { error } = await sb.from('accounts').delete().eq('email', em);
      if (error) return res.status(500).json({ error: 'Delete failed' });
      return res.status(200).json({ ok: true });
    }

    // ──────────────── LIST_OWN_JOBS ────────────────
    if (action === 'list_own_jobs') {
      const { data } = await sb.from('jobs').select('*').eq('email', em).order('created_at', { ascending: false });
      return res.status(200).json({ jobs: data || [] });
    }

    // ──────────────── CREATE_JOB ────────────────
    if (action === 'create_job') {
      const { job } = body;
      if (!job || typeof job !== 'object') return res.status(400).json({ error: 'job payload required' });
      // Whitelist actual DB columns. Anything else (camelCase legacy keys,
      // spoofed fields) is dropped before reaching Supabase upsert.
      const ALLOWED = new Set([
        'job_id','title','company','loc','prov','type','wage','category',
        'description','status','posted_date','exp_date','apply_method',
        'apply_email','apply_url','lang','edu','exp_req','vacancy','ai_use',
        'remote','requirements','benefits','biz_city','biz_prov',
        'posted_by_acc_company',
      ]);
      const clean = {};
      for (const k of Object.keys(job)) {
        if (ALLOWED.has(k)) clean[k] = job[k];
      }
      // Force the email to be the authenticated user's email (prevent spoofing)
      clean.email = em;
      clean.posted_by_acc_company = acct.company || clean.posted_by_acc_company || '';
      clean.created_at = new Date().toISOString();
      if (!clean.job_id) return res.status(400).json({ error: 'job_id required' });
      const { data, error } = await sb.from('jobs').upsert(clean, { onConflict: 'job_id' }).select();
      if (error) { console.error('create_job error:', error.message, 'payload keys:', Object.keys(clean)); return res.status(500).json({ error: 'Create failed: ' + error.message }); }
      // Notify search engines when an active job is published (fire-and-forget).
      // Submit the job URL + its location/employer landing pages + browse
      // indexes so Google re-crawls the long-tail matrix on every change.
      if (data && data[0] && data[0].status === 'active') {
        notifyIndexNowJob(data[0]).catch(() => {});
      }
      return res.status(200).json({ job: data && data[0] });
    }

    // ──────────────── UPDATE_JOB (own only, unless admin) ────────────────
    if (action === 'update_job') {
      const { job_id, patch } = body;
      if (!job_id || !patch || typeof patch !== 'object') return res.status(400).json({ error: 'job_id and patch required' });
      // Verify ownership unless admin
      if (!isAdmin) {
        const { data: j } = await sb.from('jobs').select('email').eq('job_id', String(job_id)).maybeSingle();
        if (!j) return res.status(404).json({ error: 'Job not found' });
        if (j.email !== em) return res.status(403).json({ error: 'Not your job' });
      }
      // Whitelist mutable columns. Drops camelCase legacy keys + spoofed fields.
      // email + job_id are immutable identity; created_at is set once at insert.
      const ALLOWED_PATCH = new Set([
        'title','company','loc','prov','type','wage','category',
        'description','status','posted_date','exp_date','apply_method',
        'apply_email','apply_url','lang','edu','exp_req','vacancy','ai_use',
        'remote','requirements','benefits','biz_city','biz_prov',
        'posted_by_acc_company','notified_expiry',
      ]);
      const cleanPatch = {};
      for (const k of Object.keys(patch)) {
        if (ALLOWED_PATCH.has(k)) cleanPatch[k] = patch[k];
      }
      if (Object.keys(cleanPatch).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
      const { error } = await sb.from('jobs').update(cleanPatch).eq('job_id', String(job_id));
      if (error) { console.error('update_job error:', error.message); return res.status(500).json({ error: 'Update failed: ' + error.message }); }
      return res.status(200).json({ ok: true });
    }

    // ──────────────── GET_OWN_TRANSACTIONS ────────────────
    if (action === 'get_own_transactions') {
      const { data } = await sb.from('transactions')
        .select('id, pkg, amount, credits, method, status, ref, created_at, refunded_at, card_last4, card_brand')
        .eq('email', em).order('created_at', { ascending: false });
      return res.status(200).json({ transactions: data || [] });
    }

    // ──────────────── GET_OWN_CREDITS ────────────────
    if (action === 'get_own_credits') {
      const { data } = await sb.from('credits').select('total, used').eq('email', em).maybeSingle();
      return res.status(200).json({ total: data?.total || 0, used: data?.used || 0 });
    }

    // ──────────────── SAVED_JOBS (auth required) ────────────────
    // Per-account bookmarks. UNIQUE(email,job_id) constraint makes save_job
    // idempotent — re-saving the same job is a silent no-op (insert-or-ignore).
    // No employer-vs-seeker distinction at the DB level; the UI decides who
    // sees the bookmark UI.
    if (action === 'save_job') {
      const job_id = String(body.job_id || '').trim();
      if (!job_id || !/^[0-9a-z_\-]+$/i.test(job_id)) return res.status(400).json({ error: 'invalid job_id' });
      // Confirm the job exists + is active before saving (don't let users
      // bookmark closed/expired jobs)
      const { data: job } = await sb.from('jobs').select('job_id, status').eq('job_id', job_id).maybeSingle();
      if (!job || job.status !== 'active') return res.status(404).json({ error: 'Job not found or no longer active' });
      try {
        await sb.from('saved_jobs').insert({ email: em, job_id });
      } catch (e) {
        // UNIQUE violation = already saved. Ignore — idempotent.
        if (!String(e.message || '').includes('duplicate key')) {
          console.error('save_job error:', e.message);
          return res.status(500).json({ error: 'Could not save' });
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'unsave_job') {
      const job_id = String(body.job_id || '').trim();
      if (!job_id) return res.status(400).json({ error: 'job_id required' });
      const { error } = await sb.from('saved_jobs').delete().eq('email', em).eq('job_id', job_id);
      if (error) return res.status(500).json({ error: 'Could not unsave' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'list_saved_jobs') {
      // Join with jobs to return current title/company/etc — saved bookmarks
      // surface even if the underlying job changes status, with a flag so the
      // UI can grey out non-active ones.
      const { data: rows } = await sb.from('saved_jobs')
        .select('job_id, saved_at')
        .eq('email', em)
        .order('saved_at', { ascending: false })
        .limit(200);

      const ids = (rows || []).map(r => r.job_id);
      if (ids.length === 0) return res.status(200).json({ saved_jobs: [] });

      const { data: jobs } = await sb.from('jobs')
        .select('job_id, title, company, loc, prov, type, wage, category, remote, status, exp_date')
        .in('job_id', ids);

      const byId = new Map((jobs || []).map(j => [j.job_id, j]));
      const enriched = (rows || []).map(r => ({
        saved_at: r.saved_at,
        job_id:   r.job_id,
        job:      byId.get(r.job_id) || null,
        is_active: byId.get(r.job_id)?.status === 'active'
      }));
      return res.status(200).json({ saved_jobs: enriched });
    }

    // ──────────────── UPDATE_MARKETING_OPTIN (logged-in user toggles) ────────────────
    // Used by settings page to flip marketing_opt_in. Records timestamp on opt-in
    // (CASL: must record consent date). Opt-out clears last_alert_sent_at so the
    // throttle resets if they later re-opt-in.
    if (action === 'update_marketing_optin') {
      const { opt_in } = body;
      const want = opt_in === true;
      const patch = {
        marketing_opt_in: want,
        marketing_opt_in_at: want ? new Date().toISOString() : null,
      };
      if (!want) patch.last_alert_sent_at = null;
      const { error } = await sb.from('accounts').update(patch).eq('email', em);
      if (error) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ ok: true, marketing_opt_in: want });
    }

    // ──────────────── UPDATE_ALERT_PREFS (job alert subscription) ────────────────
    // Body: { alert_prefs: { loc?, prov?, category?, remote_ok?, frequency? } }
    // Empty {} disables alerts. Any subset valid. Frequency clamped to 'daily' or
    // 'weekly' (no instant — too spammy). marketing_opt_in must be true to receive
    // alerts; we don't auto-enable opt-in here so the user makes an explicit choice.
    if (action === 'update_alert_prefs') {
      const raw = body.alert_prefs || {};
      const clean = {};
      if (raw.loc      && typeof raw.loc      === 'string' && raw.loc.length      < 100) clean.loc      = raw.loc.substring(0, 100);
      if (raw.prov     && typeof raw.prov     === 'string' && raw.prov.length     < 4)   clean.prov     = raw.prov.substring(0, 4);
      if (raw.category && typeof raw.category === 'string' && raw.category.length < 60)  clean.category = raw.category.substring(0, 60);
      if (raw.remote_ok === true) clean.remote_ok = true;
      if (raw.frequency === 'weekly' || raw.frequency === 'daily') clean.frequency = raw.frequency;
      else clean.frequency = 'daily';
      const { error } = await sb.from('accounts').update({ alert_prefs: clean }).eq('email', em);
      if (error) return res.status(500).json({ error: 'Update failed' });
      return res.status(200).json({ ok: true, alert_prefs: clean });
    }

    if (action === 'get_alert_prefs') {
      const { data } = await sb.from('accounts')
        .select('marketing_opt_in, alert_prefs')
        .eq('email', em).maybeSingle();
      return res.status(200).json({
        marketing_opt_in: !!data?.marketing_opt_in,
        alert_prefs: data?.alert_prefs || {},
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('auth-api error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
