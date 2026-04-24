import { createClient } from '@supabase/supabase-js';
import { rateLimit } from './_lib/ratelimit.js';

// Public, unauthenticated job detail. Returns the full row for ONE active
// job (including apply_email) so the client can render the apply button.
// Split from /api/list-jobs to prevent bulk email harvesting — bots would
// need to hit this endpoint once per job, and per-IP rate limiting caps
// the take.
//
// The same data is already exposed for SEO crawlers via /api/job-page
// (HTML pre-render). This endpoint is the JSON equivalent for the SPA.

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  return (Array.isArray(xff) ? xff[0] : xff.split(',')[0]).trim() || req.socket?.remoteAddress || 'unknown';
}

// Still drop internal-only columns. email (account owner) stays server-side.
const PUBLIC_COLS = [
  'job_id', 'title', 'company', 'loc', 'prov', 'biz_city', 'biz_prov',
  'type', 'category', 'wage', 'remote', 'lang', 'edu', 'exp_req',
  'vacancy', 'ai_use', 'description', 'requirements', 'benefits',
  'status', 'posted_date', 'exp_date', 'apply_method', 'apply_url',
  'apply_email',
].join(', ');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const id = String(req.query.id || '').trim();
    if (!id || !/^[0-9a-z_\-]+$/i.test(id)) return res.status(400).json({ error: 'invalid id' });

    const ip = clientIp(req);
    // 60 / IP / 10 min. Typical user clicks a handful of jobs per visit;
    // bots trying to harvest emails hit the ceiling fast.
    const ok = await rateLimit(sb, 'jobdetail:' + ip, 60, 600_000);
    if (!ok) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

    const { data: job, error } = await sb.from('jobs')
      .select(PUBLIC_COLS)
      .eq('job_id', id)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.error('job-detail error:', error.message);
      return res.status(500).json({ error: 'Failed to load job' });
    }
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ job });
  } catch (err) {
    console.error('job-detail exception:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
