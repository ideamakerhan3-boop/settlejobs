# YouthHire Operator Runbook

> Single source of truth for operating canadayouthhire.ca.
> Read this when you've inherited the project or are on-call.

## TL;DR — Where everything lives

| Concern | Service | Account / Login |
|---|---|---|
| Source code | GitHub `ideamakerhan3-boop/youthhire` | Owner: ideamakerhan3-boop |
| Deployment | Vercel project `youthhire` (`prj_uFFCDb0S7HXCnArzr5VRSUwA5mJb`) | Team: `team_zsrOjeC2B4XqPmzfXE9e8lVw` |
| Database | Supabase project `xouvuqqkbtaikrnnueda` (region `ca-central-1`) | Org: `creblzypkzajfvtdqcfi` |
| Email | Resend (verified domain `canadayouthhire.ca`) | Login: `ideamakerhan4@gmail.com` via Google OAuth |
| Domain | IONOS (registrar) | Customer ID `316083950`, login `ideamakerhan2@gmail.com`. Expires 2027-04-23. |
| DNS | Vercel DNS (managed via Vercel dashboard) | — |
| Payments | Stripe (CAD) | — |
| Admin email | `ideamakerhan2@gmail.com` | The ONLY `is_admin=true` row in the DB. |

## Production URL map

- Site: `https://www.canadayouthhire.ca` and `https://canadayouthhire.ca`
- Status page: `/status` (public, edge-cached 60s, shows active jobs / 24h errors / recent jobs)
- Public REST API:
  - `GET /api/v1/jobs` (paginated, filterable by prov/category/employment_type/remote/since/q)
  - `GET /api/v1/jobs/:id`
  - `GET /api/v1/stats` (active_jobs/employers/cities/provinces/postings_30d)
- Sitemap: `/sitemap.xml` (~48 entries)
- RSS feed: `/feed.xml` (Indeed/Jooble/Adzuna/etc. crawl this)
- Robots: `/robots.txt`
- API docs page: `/api`

## Branch / deploy flow

```
local edit
   ↓ git commit
local branch (feat/* fix/* chore/* docs/* etc.)
   ↓ git push -u origin <branch>
GitHub PR
   ↓ CI: .github/workflows/pr-syntax-check.yml (node --check on api/, scripts/)
   ↓ CI: Vercel Preview deployment
PR Merge (squash) to main
   ↓ webhook
Vercel production build + deploy (~1-2 min)
   ↓
post-merge-smoke.yml workflow runs scripts/smoke.mjs (20 checks)
```

**Hot rollback**: Vercel Deployments tab → pick an earlier `READY` build → ⋯ → "Promote to Production". Production switches instantly, GitHub `main` unchanged.

**Git rollback**: `git revert <bad-commit>` + push to a `revert/<thing>` branch + PR + merge. Vercel deploys the revert.

## Environment variables (Vercel project `youthhire`)

| Key | Purpose | Set? |
|---|---|---|
| `SUPABASE_URL` | Supabase API base | ✅ |
| `SUPABASE_SERVICE_KEY` | Server-side DB access (bypasses RLS) | ✅ |
| `SUPABASE_ANON_KEY` | Client-side read access (RLS enforced) | ✅ |
| `STRIPE_SECRET_KEY` | Payments + refunds | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification | ✅ |
| `RESEND_API_KEY` | Outbound email | ✅ (rotate quarterly) |
| `BRAND_FROM_EMAIL` | `info@canadayouthhire.ca` | ✅ |
| `BRAND_FROM_NAME` | "Canada Youth Hire" | ✅ |
| `BRAND_REPLY_TO` | `info@canadayouthhire.ca` | ✅ |
| `BRAND_POSTAL_ADDR` | CASL physical address footer | ⏸️ See pending action |
| `ALERT_PHONE_EMAIL` | SMS gateway for ops alerts | ⏸️ See pending action |
| `CRON_SECRET` | Vercel cron auth | ✅ |
| `ADMIN_API_KEY` | Manual export-data trigger | ✅ |
| `INDEXNOW_KEY` | Search engine ping auth | ✅ |
| `TURNSTILE_SECRET` | Cloudflare Turnstile bot block | ✅ |
| `TWILIO_*` (3 vars) | Voice alert for critical errors | ✅ |

Set via Vercel dashboard → Settings → Environment Variables → Add New → Production+Preview+Development → Save → Deployments → Redeploy.

## Cron jobs (Vercel cron, all in UTC)

| Path | Schedule | What |
|---|---|---|
| `/api/expire-jobs` | `0 14 * * *` daily (14:00 UTC = 09:00 EST / 06:00 PST) | Mark expired jobs + send 7-day expiry reminders + send CASL marketing alert digests |
| `/api/export-data` | `0 3 * * 0` weekly Sun (03:00 UTC) | JSON backup of 7 tables to Supabase Storage |
| `/api/health-check` | `0 12 * * *` daily (12:00 UTC) | Site UP check, HTML integrity, refund anomaly scan; SMS+voice alert on fail |

Cron URLs return 401 unless `Authorization: Bearer <CRON_SECRET>` header set (Vercel sets it automatically). Comparison is now timing-safe (PR #70).

## Database (Supabase)

Tables (13):
- `accounts` — users (admin + employers + Leo's test accounts)
- `jobs` — job postings (30 columns including SEO fields)
- `credits` — credit balances (total, used)
- `transactions` — Stripe payment records (idempotent on `ref`)
- `saved_jobs` — bookmarks (backend ready, UI not wired)
- `events` — self-hosted analytics (insert-only, log-bomb-resistant)
- `error_logs` — client + server error capture (auto-truncated)
- `rate_limits` — DB-backed rate limit counters
- `promo_codes` + `promo_usage` — promo redemption
- `admin_settings` — config singleton
- `monitor_state` — health-check state
- `issue_jobs` — admin flag list

RLS posture: tables that hold non-public data (events, error_logs, rate_limits, saved_jobs) have `RLS ENABLED` but **no policies** — only service-role can read them. Supabase advisor reports this as INFO, intentional.

Admin SQL via Supabase Studio: https://supabase.com/dashboard/project/xouvuqqkbtaikrnnueda/sql

Backup: weekly `/api/export-data` cron writes JSON to Supabase Storage. 30-day retention.

## Function inventory (Vercel Hobby cap = 12)

```
api/admin-api.js         — admin actions dispatcher
api/auth-api.js          — auth + many dispatched actions (register/login/reset/saved_jobs/marketing/alerts/track_event/log_error/create_job/update_job/...)
api/create-checkout.js   — Stripe Checkout session creation
api/credits-api.js       — credit use/grant/promo (with server-side gift email)
api/expire-jobs.js       — cron handler
api/export-data.js       — backup cron handler
api/health-check.js      — health-check cron
api/job-page.js          — bot SSR + landing pages + trust pages + status + API docs (huge dispatcher)
api/list-jobs.js         — list + detail (with ?public=1 mode for /api/v1)
api/refund.js            — admin-only Stripe refund
api/sitemap.js           — XML sitemap + RSS feed
api/stripe-webhook.js    — Stripe event handler (idempotent on session.id)
```

**You are AT the cap.** Adding a 13th file = silent deploy failure. Future features must dispatch through existing endpoints (action/type query param). When you must add room, merge `refund.js` into `admin-api.js` as an `action === 'refund'` dispatch — this is the cheapest cut.

## Smoke test (manual or auto)

```
node scripts/smoke.mjs https://www.canadayouthhire.ca
```

20 checks across Static/SPA, JobPosting bot/human split, landing matrix, honest 404, REST API v1, trust pages.

Auto-runs on every main push via `.github/workflows/post-merge-smoke.yml`. Failure → red ✗ on the commit + email notification.

## Common operations

### Check who's admin
```sql
SELECT email, is_admin, name, created_at
  FROM accounts WHERE is_admin = true;
```
Should return exactly one row: `ideamakerhan2@gmail.com`.

### Promote / demote admin
```sql
UPDATE accounts SET is_admin = true WHERE email = 'new-admin@example.com';
```

### See active jobs
```sql
SELECT job_id, title, company, loc, exp_date, created_at
  FROM jobs WHERE status = 'active' ORDER BY created_at DESC;
```

### Force-expire a stuck job
```sql
UPDATE jobs SET status = 'expired' WHERE job_id = '<id>';
```

### Manual run a cron
```
curl -X GET "https://www.canadayouthhire.ca/api/expire-jobs" \
     -H "Authorization: Bearer <CRON_SECRET>"
```

### Send a one-off test email
Easiest path: trigger via `/forgot` page with an admin email. Confirms full Resend pipeline end-to-end.

### Refund a payment (admin only)
Use admin.html UI → Revenue panel → Refund button.
Or hit `POST /api/refund` with `{payment_intent, email, pw_hash}` from an admin account. Rate-limited 20/h/IP since PR #68.

### Block a spammer / abusive employer
```sql
UPDATE accounts SET status = 'suspended' WHERE email = '<spammer>';
UPDATE jobs SET status = 'expired' WHERE email = '<spammer>' AND status = 'active';
```

## Incident response

### Site is down (Vercel deploy failed)
1. Vercel Deployments → check failed build's log
2. If a recent merge caused it, find the prior `READY` build → ⋯ → "Promote to Production" (instant rollback)
3. Open PR to revert the breaking change

### Email not sending
1. Check `[RESEND_FAIL]` in Vercel logs for the affected function
2. Verify Resend dashboard: API key valid? Domain still verified? Daily quota not hit? (3000/mo)
3. Check `BRAND_FROM_EMAIL` env var is set
4. Test-send via `/forgot` to your own email — if that arrives, the pipeline is fine

### CASL marketing emails not going out
1. Confirm `BRAND_POSTAL_ADDR` Vercel env is set (helper hard-fails without it)
2. Confirm `BRAND_FROM_EMAIL` set
3. Recipient has `marketing_opt_in = true` and `unsub_token` in DB
4. Check cron ran (Vercel cron logs at 14:00 UTC)

### Payment / credit out of sync
1. Run `node scripts/audit-credits.mjs` (if exists) or query manually:
```sql
SELECT a.email, c.total, c.used,
       (SELECT count(*) FROM jobs WHERE email = a.email AND status='active') AS active_jobs
FROM accounts a LEFT JOIN credits c ON c.email = a.email
WHERE c.total IS NOT NULL;
```
2. Stripe webhook (`stripe-webhook.js`) has idempotent retry — fix is usually just letting it re-fire from Stripe dashboard → Events → Resend
3. Manual adjustment via admin.html → Credits panel → Gift / refund

### Search engines stopped crawling
1. Check `/sitemap.xml` returns 200 + non-empty
2. Verify in Google Search Console → Coverage
3. Manual ping via Vercel logs: `curl /api/list-jobs?type=stats` should show today's jobs
4. IndexNow auto-pings on every job change — confirm `INDEXNOW_KEY` env still set

### Suspicious activity
1. Check `error_logs` table for patterns:
```sql
SELECT message, count(*) FROM error_logs
WHERE ts > NOW() - INTERVAL '24 hours'
GROUP BY message ORDER BY count DESC LIMIT 20;
```
2. Check `events` table for spike on a single IP / session_id
3. Check `rate_limits` table for keys hitting their cap

## Quarterly maintenance

- [ ] Rotate Resend API key (Resend dashboard → revoke old → create new → update Vercel env → Redeploy)
- [ ] Rotate `CRON_SECRET` (same flow)
- [ ] Rotate `STRIPE_WEBHOOK_SECRET` (Stripe dashboard → roll secret → update Vercel env)
- [ ] Review Supabase advisors: https://supabase.com/dashboard/project/xouvuqqkbtaikrnnueda/advisors
- [ ] Verify backups exist: list `/api/export-data` cron logs from last 4 weeks
- [ ] Domain renewal at 30-day mark before 2027-04-23

## Annual maintenance

- [ ] Renew domain at IONOS (2027-04-23 first renewal)
- [ ] Audit `accounts.is_admin = true` set — should still be exactly Leo
- [ ] Review unused Vercel env vars and clean up
- [ ] Audit CASL marketing opt-in records vs sent emails

## Useful links

- Live site: https://www.canadayouthhire.ca
- Status: https://www.canadayouthhire.ca/status
- API docs: https://www.canadayouthhire.ca/api
- Vercel dashboard: https://vercel.com/ideamakerhan-1414s-projects/youthhire
- Supabase dashboard: https://supabase.com/dashboard/project/xouvuqqkbtaikrnnueda
- Resend dashboard: https://resend.com
- Stripe dashboard: https://dashboard.stripe.com
- GitHub repo: https://github.com/ideamakerhan3-boop/youthhire
- IONOS domains: https://my.ionos.com/domains

## Things this site deliberately does NOT do

- **In-app job applications** — candidates apply directly via `apply_email` or `apply_url` set on each job. We do not store or relay applications. No application receipt email by design.
- **Real-time chat / messaging** — no inbox, no DM, no PM.
- **Resumes / candidate profiles** — we don't host candidate data beyond email for marketing opt-ins.
- **Auto-charging recurring subscriptions** — payments are one-shot credit packs.

## Code conventions

- Branch names: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `revert/`, `cleanup/`, `safety/`, `debug/`
- Commits: imperative present tense, Co-Authored-By footer when Claude assists
- PRs: title is short (<70 chars), body has Summary + Test plan
- No `--no-verify`, no `--force` push to main, no skipping hooks
- `node --check` must pass (enforced by CI)
- `scripts/smoke.mjs` must pass post-merge (auto)
