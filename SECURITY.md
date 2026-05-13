# Security Posture — YouthHire

> What the site protects, how it does it, and the known gaps.
> Last reviewed 2026-05-12 (after PR #64-#74 audit + hardening pass).

## Reporting a vulnerability

Email `info@canadayouthhire.ca` with details. Do **not** open a public GitHub issue for vulnerabilities. Expect a response within 72 hours.

## Authentication

- **Passwords**: bcrypt at rest (12 rounds). Legacy SHA-256-only accounts are transparently upgraded to bcrypt on next successful login (`api/_lib/verify.js`).
- **Client→server**: client hashes password with unsalted SHA-256 before sending. TLS protects in transit. Server stores bcrypt. Trade-off: TLS leak could replay this account but not other accounts (bcrypt-at-rest), and attacker can't brute-force the password (SHA-256 over plaintext, not the bcrypt hash).
- **Session**: localStorage `cjb_email` + `cjb_pw_hash` (the SHA-256 hash sent on each authenticated request). No JWT, no cookie session.
- **Password reset**: token flow. Server generates 64-char hex token, stores `sha256(token)` in `accounts.reset_token_hash` with 1-hour TTL. Email contains the plaintext token. `verify_reset` action accepts token + new password hash, single-use. Tokens are rate-limited (10/h/email, 30/h/IP after PR #64).

## Authorization

- **Single admin**: `accounts.is_admin = true` set on exactly one row (`ideamakerhan2@gmail.com`). Admin actions all verify this server-side via `accounts.is_admin` lookup after password verification.
- **Service-role isolation**: server uses `SUPABASE_SERVICE_KEY` (bypasses RLS). Browser uses `SUPABASE_ANON_KEY` (RLS enforces). RLS is the perimeter for non-public tables — see "Database" below.
- **No anonymous writes**: every state-changing API path requires email + pw_hash. Anonymous reads OK for `list-jobs` (filtered to active jobs + non-PII columns).

## Database (Supabase Postgres)

- **PII column allowlist**: `jobs` table has 28 columns, but the anon key has `GRANT SELECT` on only the public subset (no `email`, no `apply_email` unless going through the server). Server-side service role bypasses this.
- **RLS posture**:
  - Public-readable: `jobs`, `accounts` (via column GRANT), `promo_codes`
  - Service-role-only (RLS enabled, no policies): `events`, `error_logs`, `rate_limits`, `saved_jobs`, `transactions`, `credits`, `promo_usage`, `admin_settings`, `monitor_state`, `issue_jobs`
- **Idempotent payments**: `transactions.ref` (Stripe session id) has a UNIQUE constraint. Webhook replay → duplicate insert fails → skip.
- **Backups**: weekly `/api/export-data` cron writes JSON of 7 tables to Supabase Storage. 30-day retention. Off-Supabase replica is **a gap** — Supabase project compromise/deletion loses backups too.

## Input handling

- **Email**: validated against `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, capped at 254 chars.
- **Job content** (PR #68): per-column length caps on `create_job` — title 200, description 20K, requirements/benefits 5K, apply_url 500, etc. Anything past the cap is silently truncated.
- **Analytics events** (PR #68): event_type whitelist (14 strings), meta JSON capped at 2KB.
- **Error log**: message capped at 500 chars, stack at 2000 chars.
- **Honeypot**: register action has a hidden `_hp` field — bots fill it, humans don't. Silent success returned to bots (no error feedback, blocks credential stuffing reconnaissance).
- **Turnstile**: Cloudflare Turnstile token required on register, login, reset_request. Bots that pass need to also pass per-IP rate limits.

## Rate limits

DB-backed counters via `rate_limits` table. Atomic increment is non-atomic in worst-case concurrency (~10-20% slip under flood), acceptable trade-off for free-tier.

| Endpoint / action | Limit |
|---|---|
| `register` | 10/h per IP |
| `login` | 5/min per IP |
| `request_reset` per email | 10/h |
| `request_reset` per IP | 30/h |
| `verify_reset` per IP | 10/h |
| `track_event` per IP | 100 / 5 min |
| `log_error` per IP | 50 / 5 min |
| `admin_login_by_pw_only` per IP | 5/min |
| `/api/refund` per IP | 20/h (PR #68) |

## Cron secret

- `CRON_SECRET` env var. Vercel auto-injects `Authorization: Bearer <CRON_SECRET>` to scheduled invocations.
- Compared with `crypto.timingSafeEqual` after length-mismatch early-exit (PR #70 — prevents timing side-channel from leaking secret length).
- Manual cron trigger requires the secret too.

## Stripe security

- **Webhook signature verified** via `stripe.webhooks.constructEvent`. Mismatch → 400 reject.
- **Amount validation**: server checks `session.amount_total` matches expected package price. Mismatch → 400 reject (no credits granted).
- **Idempotent**: ref/session-id duplicate check before credit grant.
- **Orphan refund alert**: if Stripe refund event arrives for a payment_intent we don't have in DB, send SMS + voice call. Webhook returns 500 (Stripe retries 3 days).
- **Refund flow rate-limited**: 20/h/IP (PR #68) to cap blast radius from compromised admin credentials.

## Email security

- **Verified domain DKIM**: `canadayouthhire.ca` is Resend-verified. Outbound mail signed with DKIM key at `resend._domainkey.canadayouthhire.ca` TXT record.
- **SPF**: `send.canadayouthhire.ca` has SPF `v=spf1 include:amazonses.com ~all` (Resend uses SES under the hood).
- **No client-side credential exposure**: post-PR #51 there is no API key in the browser bundle. All sends go through `/api/_lib/email.js` server-side.
- **CASL compliance**: `sendMarketingEmail()` is fail-loud if `BRAND_FROM_EMAIL` or `BRAND_POSTAL_ADDR` are unset — refuses send + logs `[MARKETING_BLOCKED]`. Currently `BRAND_POSTAL_ADDR` is unset (pending Leo action) — marketing digest cron silently skips all sends. Acceptable because opt-in count is 0.

## Headers + CORS

Set globally in `vercel.json`:
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=() microphone=() geolocation=() payment=(self)`
- `Cross-Origin-Opener-Policy: same-origin-allow-popups`
- `Content-Security-Policy: ...` (strict allowlist: self + Stripe + jsdelivr for Supabase SDK + Google Fonts)

CORS on public API endpoints (`/api/v1/jobs`, `/api/v1/stats`) returns `Access-Control-Allow-Origin: *` — intentional, these are documented public read APIs.

## What we do NOT collect

- No application data (candidates apply directly to employers via email/URL — out-of-band)
- No resume / candidate profile data
- No 3rd-party analytics (no GA, no Mixpanel, no FB Pixel). Self-hosted `events` table only.
- No cookies (session is localStorage). Cookie-banner not needed.
- No browser fingerprinting
- IPs are stored in rate_limits + events tables (truncated automatically by retention policy)

## Known gaps (acknowledged, in backlog)

| Gap | Severity | Notes |
|---|---|---|
| Vercel function count at 12/12 cap | Operational | Adding a 13th file = silent deploy fail. Migrate `refund.js` → `admin-api.js` action when room is needed. |
| Backup is in same Supabase project | Medium | If project gets deleted/compromised, backups go too. Off-Supabase replica is future work. |
| ~~Admin (`admin.html`) renders `innerHTML` with employer-supplied fields~~ | ~~Low~~ | **✅ Fixed PR #77 (2026-05-13)** — 12 callsites wrapped with `escHtml` (job title/company/loc/salary/email + tx co/email). `mailto:` href uses `encodeURIComponent`. |
| stripe-webhook retry path uses email-only lock | Very low | Race between `SELECT cr2` and retry `UPDATE` could overwrite a concurrent credit change. Probability low; impact = credit balance discrepancy. Atomic-RPC fix is the proper solution. |
| `_ACCOUNTS[em].pw` fallback on shared device | Low | Browser memory holds previously-logged-in users' SHA-256 hash. Shared-device residual risk. Not exploitable without local access. |
| Daily-only health-check cron | Operational | Vercel Hobby plan caps cron frequency. Site outage between 12:00 UTC ticks = up to 24h detection lag. Synthetic external monitor (e.g., UptimeRobot 5min) would fix. |
| `BRAND_POSTAL_ADDR` env unset | Compliance | CASL marketing emails would block silently. Currently 0 opt-in users so no impact. Pending Leo to set in Vercel dashboard. |

## Incident response

See `OPERATOR.md` → "Incident response" section for runbooks on site-down, email-not-sending, payment-sync, suspicious-activity, etc.

For credential compromise specifically:
1. Rotate the affected secret immediately (Resend / Stripe / Supabase / Vercel dashboards)
2. Update Vercel env var
3. Redeploy
4. Audit logs for malicious activity in the window between leak and rotation
5. Notify affected users if data exposure occurred (PIPEDA / CASL)

## Audit history

- 2026-05-11: Comprehensive automated audit + manual review. 6 findings fixed (PR #66 / #68 / #69 / #70 / #72 / #73). 4 gaps acknowledged (above table).
- 2026-05-12: Smoke test expanded to 27 checks including security-posture verification (PR #74). Audit re-run found no new high-priority items.
- 2026-05-13: Admin innerHTML XSS gap (was: Low severity known gap) closed in PR #77. 12 employer-controlled fields now escaped via existing `escHtml` helper. SECURITY.md gap table updated.
