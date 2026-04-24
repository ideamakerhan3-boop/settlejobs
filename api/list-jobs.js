import { createClient } from '@supabase/supabase-js';
import { rateLimit } from './_lib/ratelimit.js';

// Public, unauthenticated listing of active jobs for the home page feed
// and anonymous search. Service key bypasses RLS; only safe public columns
// are selected. Rate-limited per IP to blunt scraping abuse.

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

// Columns safe for anonymous disclosure. Notably excludes:
//   email, apply_email (contact info — only shown on detail page),
//   created_at, notified_expiry, updated_at (internal timestamps).
const PUBLIC_COLS = [
  'job_id', 'title', 'company', 'loc', 'prov', 'biz_city', 'biz_prov',
  'type', 'category', 'wage', 'remote', 'lang', 'edu', 'exp_req',
  'vacancy', 'ai_use', 'description', 'requirements', 'benefits',
  'status', 'posted_date', 'exp_date', 'apply_method', 'apply_url',
].join(', ');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const ip = clientIp(req);
    // 100 requests per IP per 10 minutes — plenty for real users, blunts scraping.
    const ok = await rateLimit(sb, 'listjobs:' + ip, 100, 600_000);
    if (!ok) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

    const { data, error } = await sb.from('jobs')
      .select(PUBLIC_COLS)
      .eq('status', 'active')
      .order('posted_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('list-jobs error:', error.message);
      return res.status(500).json({ error: 'Failed to load jobs' });
    }

    // Short cache — anonymous homepage feed can be slightly stale.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ jobs: data || [] });
  } catch (err) {
    console.error('list-jobs exception:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
