# YouthHire — Canada's Youth Job Board

[![Status](https://img.shields.io/badge/status-live-success)](https://www.canadayouthhire.ca/status)
[![Smoke](https://github.com/ideamakerhan3-boop/youthhire/actions/workflows/post-merge-smoke.yml/badge.svg)](https://github.com/ideamakerhan3-boop/youthhire/actions/workflows/post-merge-smoke.yml)
[![Site](https://img.shields.io/badge/site-canadayouthhire.ca-2563EB)](https://www.canadayouthhire.ca)

Job board for Canadian youth (16–29 years old). Employers post entry-level / part-time / first-job opportunities; candidates apply directly via the employer's email or external apply URL.

## What this is — and isn't

**Is**:
- A simple, fast, mobile-friendly job listing site
- Entry-level / part-time / first-job focused
- Public REST API for partners (university career portals, youth organizations)
- CASL-compliant marketing infrastructure (job alert digests, opt-in)
- Self-hosted analytics (no Google Analytics, no 3rd-party trackers, no cookies)

**Isn't**:
- An in-app application system — candidates apply directly to employers via email/URL (we don't store applications or resumes)
- A chat / messaging platform
- A subscription service — payments are one-shot credit packs
- A general-purpose job board (we're youth-focused on purpose)

## Public surface

| URL | Purpose |
|---|---|
| https://www.canadayouthhire.ca | Site |
| /status | Live operational signal |
| /api/v1/jobs | Public REST API — paginated job list with filters |
| /api/v1/jobs/:id | Single job |
| /api/v1/stats | Active jobs / employers / cities / provinces / 30-day count |
| /api | API docs page |
| /sitemap.xml | Sitemap (~48 URLs) |
| /feed.xml | RSS 2.0 feed |
| /about-youth-employment | Trust / compliance page |

## Tech stack

- **Frontend**: Vanilla JS SPA (no framework, no build step for HTML). Single `index.html` + `admin.html`.
- **Backend**: Vercel serverless functions (Node 20 ES modules)
- **Database**: Supabase (Postgres + RLS)
- **Email**: Resend (verified domain DKIM)
- **Payments**: Stripe (one-shot credit packs)
- **Domain**: IONOS, DNS via Vercel
- **CI**: GitHub Actions (syntax check + post-merge smoke)

## Repository structure

```
api/                    Vercel serverless functions (12 / 12 Hobby cap)
  _lib/                 shared helpers (email, alerts, ratelimit, verify, marketing-config)
  auth-api.js           auth + many dispatched actions (register/login/reset/saved_jobs/...)
  job-page.js           bot SSR + landing pages + trust + status + API docs
  list-jobs.js          job list + detail + /api/v1 public API
  credits-api.js        credit use/grant/promo
  create-checkout.js    Stripe Checkout session
  stripe-webhook.js     Stripe event handler
  refund.js             admin-only refund
  expire-jobs.js        cron: 14:00 UTC daily
  export-data.js        cron: backup weekly
  health-check.js       cron: daily uptime
  admin-api.js          admin action dispatcher
  sitemap.js            XML sitemap + RSS feed

scripts/
  smoke.mjs             27-check live smoke test (auto-runs post-merge)

index.html              Public SPA (~85% of user-facing code)
admin.html              Admin panel SPA
vercel.json             Routes + headers + cron schedule + function caps
.github/workflows/
  pr-syntax-check.yml   node --check on every PR
  post-merge-smoke.yml  scripts/smoke.mjs on every main push

OPERATOR.md             Single-page runbook for future operators
SECURITY.md             Security posture + reporting
```

## Local development

This repo doesn't have a local dev loop — production debugging happens via Vercel Preview deployments on each PR.

To run the smoke test against prod:

```bash
node scripts/smoke.mjs
# or against any other base URL:
node scripts/smoke.mjs https://your-preview-url.vercel.app
```

## Contributing

This is a single-operator project. Direct contributions aren't accepted, but issues and security reports are welcome:

- Bug: open a GitHub issue
- Security: see [SECURITY.md](SECURITY.md)
- Job board content (employers): post via the website itself

## License

All rights reserved. Source is visible for transparency and security audit but not licensed for reuse. Contact `info@canadayouthhire.ca` for licensing inquiries.

## Operations

See [OPERATOR.md](OPERATOR.md) for:
- Where everything lives (Vercel, Supabase, Resend, Stripe, IONOS)
- Branch / deploy flow + rollback
- Environment variables
- Cron schedules
- Common operations + incident response
- Quarterly + annual maintenance

## Security

See [SECURITY.md](SECURITY.md) for:
- Auth + authz posture
- Rate limit matrix
- Payment + email security
- Known gaps (acknowledged)
- Reporting a vulnerability

## Status

- 🟢 Production live
- ⚪ Active jobs: see [/status](https://www.canadayouthhire.ca/status) for live signal
- Last reviewed: 2026-05-12 (post-audit hardening pass — 12 PR series #64-#75)
