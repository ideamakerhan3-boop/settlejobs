import { createClient } from '@supabase/supabase-js';
import { rateLimit } from './_lib/ratelimit.js';

// Public, unauthenticated read path for jobs.
//
// Three modes, one function (Vercel Hobby plan caps us at 12 serverless
// functions, so we can't split this):
//   GET /api/list-jobs                — array of active jobs for the SPA feed;
//                                       drops apply_email to block bulk harvest.
//   GET /api/list-jobs?id=<job_id>    — single active job including apply_email,
//                                       hit lazily when the user clicks a card.
//   GET /api/list-jobs?type=stats     — aggregate counts (active jobs, employers,
//                                       cities, postings_30d) for the hero card.
//
// Public REST API (partner integrations like university career portals,
// aggregator feeds beyond RSS) is exposed via versioned rewrites in
// vercel.json:
//   /api/v1/jobs   → /api/list-jobs?public=1[&filters...]
//   /api/v1/stats  → /api/list-jobs?type=stats&public=1
// `public=1` flips CORS to `*` (open partner access) and applies a tighter
// per-IP rate limit so a single partner can't drain capacity. Versioning
// under /v1/ means we can change the SPA contract without breaking partners.
//
// Service key bypasses RLS; column allow-list enforces what leaves the DB.

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ALLOWED_ORIGINS = [
  'https://www.canadayouthhire.ca',
  'https://canadayouthhire.ca',
];

function setCors(req, res, isPublic) {
  if (isPublic) {
    // Open CORS — partners can call from anywhere
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // SPA-only CORS — origin allow-list + Vercel preview pattern
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/youthhire-[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return (Array.isArray(xff) ? xff[0] : xff.split(',')[0]).trim() || req.socket?.remoteAddress || 'unknown';
}

const LIST_COLS = [
  'job_id', 'title', 'company', 'loc', 'prov', 'biz_city', 'biz_prov',
  'type', 'category', 'wage', 'remote', 'lang', 'edu', 'exp_req',
  'vacancy', 'ai_use', 'description', 'requirements', 'benefits',
  'status', 'posted_date', 'exp_date', 'apply_method', 'apply_url',
].join(', ');

const DETAIL_COLS = LIST_COLS + ', apply_email';

// Public API exposes a slimmer shape — drops internal-y fields like
// `vacancy`, `ai_use`, `biz_city/prov`, `status` that aren't useful to
// partners and might confuse them.
const PUBLIC_COLS = [
  'job_id', 'title', 'company', 'loc', 'prov',
  'type', 'category', 'wage', 'remote', 'lang',
  'edu', 'exp_req', 'description', 'requirements',
  'benefits', 'posted_date', 'exp_date', 'apply_method', 'apply_url',
].join(', ');

export default async function handler(req, res) {
  const isPublic = String(req.query.public || '') === '1';
  setCors(req, res, isPublic);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const ip = clientIp(req);
  const id = String(req.query.id || '').trim();
  const queryType = String(req.query.type || '').trim();

  try {
    // ─── Stats mode ───────────────────────────────────────────────
    // Aggregate counts for the hero card and partner consumption. Cached
    // for 5 minutes so it doesn't hammer the DB on every page load.
    if (queryType === 'stats') {
      const ok = await rateLimit(sb, (isPublic ? 'pubstats:' : 'stats:') + ip, isPublic ? 60 : 300, 600_000);
      if (!ok) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

      const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
      const [activeJobs, allJobs30d, distinctRows] = await Promise.all([
        sb.from('jobs').select('job_id', { count: 'exact', head: true }).eq('status', 'active'),
        sb.from('jobs').select('job_id', { count: 'exact', head: true }).gte('created_at', since30),
        sb.from('jobs').select('company, loc, prov').eq('status', 'active').limit(2000),
      ]);

      const employers = new Set();
      const cities    = new Set();
      const provinces = new Set();
      for (const r of (distinctRows.data || [])) {
        if (r.company) employers.add(r.company.trim().toLowerCase());
        if (r.loc)     cities.add((r.loc + (r.prov ? '|' + r.prov : '')).trim().toLowerCase());
        if (r.prov)    provinces.add(r.prov.trim().toUpperCase());
      }

      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({
        active_jobs:  activeJobs.count ?? 0,
        employers:    employers.size,
        cities:       cities.size,
        provinces:    provinces.size,
        postings_30d: allJobs30d.count ?? 0,
        as_of:        new Date().toISOString(),
      });
    }

    // ─── Detail mode ──────────────────────────────────────────────
    if (id) {
      if (!/^[0-9a-z_\-]+$/i.test(id)) return res.status(400).json({ error: 'invalid id' });
      const ok = await rateLimit(sb, (isPublic ? 'pubdetail:' : 'jobdetail:') + ip, isPublic ? 30 : 60, 600_000);
      if (!ok) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

      const cols = isPublic ? PUBLIC_COLS : DETAIL_COLS;
      const { data: job, error } = await sb.from('jobs')
        .select(cols)
        .eq('job_id', id)
        .eq('status', 'active')
        .maybeSingle();

      if (error) {
        console.error('list-jobs detail error:', error.message);
        return res.status(500).json({ error: 'Failed to load job' });
      }
      if (!job) return res.status(404).json({ error: 'Job not found' });

      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ job });
    }

    // ─── List mode ────────────────────────────────────────────────
    // Tighter rate limit on the public path (30/10min vs 100/10min for SPA)
    // — partners are expected to fetch periodically, not on every page render.
    const ok = await rateLimit(sb, (isPublic ? 'publist:' : 'listjobs:') + ip, isPublic ? 30 : 100, 600_000);
    if (!ok) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

    // Optional filters — public API only (SPA contract stays stable)
    let q = sb.from('jobs')
      .select(isPublic ? PUBLIC_COLS : LIST_COLS)
      .eq('status', 'active');

    if (isPublic) {
      const prov     = String(req.query.prov || '').toUpperCase().slice(0, 4);
      const category = String(req.query.category || '').slice(0, 60);
      const empType  = String(req.query.employment_type || '').slice(0, 30);
      const remote   = String(req.query.remote || '');
      const since    = String(req.query.since || '');
      const kw       = String(req.query.q || '').slice(0, 80);

      if (prov && /^[A-Z]{2}$/.test(prov)) q = q.eq('prov', prov);
      if (category) q = q.eq('category', category);
      if (empType)  q = q.eq('type', empType);
      if (remote === 'true' || remote === '1') q = q.ilike('remote', '%remote%');
      if (since && /^\d{4}-\d{2}-\d{2}/.test(since)) q = q.gte('created_at', since);
      if (kw) {
        // Strip PostgREST-syntax-significant chars to defeat injection of
        // additional filters into the .or() expression.
        const safe = kw.replace(/[%_,()]/g, '');
        if (safe) q = q.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
    }

    const { data, error } = await q
      .order('posted_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('list-jobs error:', error.message);
      return res.status(500).json({ error: 'Failed to load jobs' });
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    if (isPublic) {
      // Versioned envelope — partners can detect schema changes
      return res.status(200).json({
        api_version: 'v1',
        count:       (data || []).length,
        offset,
        limit,
        jobs:        data || []
      });
    }
    return res.status(200).json({ jobs: data || [] });
  } catch (err) {
    console.error('list-jobs exception:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
