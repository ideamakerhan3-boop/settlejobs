import { createClient } from '@supabase/supabase-js';
// Cross-import: pulls job-page.js into this function's bundle (~small size
// bump, no functional impact — see lessons/seo-landing-pages.md "함정 2").
// Keeps the slug whitelists DRY across renderer and sitemap.
import { PROVINCE_SLUGS, CATEGORY_SLUGS, EMPLOYMENT_TYPE_SLUGS } from './job-page.js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/**
 * Slugify + normalizeLoc — mirrored from api/job-page.js, keep in sync.
 */
function slugify(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

function normalizeLoc(loc, prov) {
  if (!loc) return '';
  if (!prov) return String(loc).trim();
  const re = new RegExp(',?\\s*' + String(prov).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
  return String(loc).replace(re, '').trim();
}

// 47 major Canadian cities with concentrated youth/student populations
// (university towns + metro cores + each provincial capital). Pre-seeded into
// the sitemap so /locations/<slug> URLs are indexable before the first job
// goes live in that city — the renderer falls back to a "check back" copy
// with stable schema. Keep alphabetized within each province for review hygiene.
const PRE_SEED_CITIES = [
  // Ontario — GTA, Hamilton-Niagara, Ottawa, Southwestern uni towns
  ['Toronto', 'ON'], ['Mississauga', 'ON'], ['Brampton', 'ON'], ['Ottawa', 'ON'],
  ['Hamilton', 'ON'], ['London', 'ON'], ['Kitchener', 'ON'], ['Waterloo', 'ON'],
  ['Windsor', 'ON'], ['Markham', 'ON'], ['Guelph', 'ON'], ['Oshawa', 'ON'],
  ['St. Catharines', 'ON'],
  // Quebec — Montreal metro + Quebec City + uni towns
  ['Montreal', 'QC'], ['Quebec City', 'QC'], ['Gatineau', 'QC'], ['Sherbrooke', 'QC'],
  ['Trois-Rivieres', 'QC'],
  // British Columbia — Lower Mainland + Victoria + Okanagan + Island
  ['Vancouver', 'BC'], ['Surrey', 'BC'], ['Burnaby', 'BC'], ['Richmond', 'BC'],
  ['Victoria', 'BC'], ['Coquitlam', 'BC'], ['Kelowna', 'BC'], ['Nanaimo', 'BC'],
  ['Abbotsford', 'BC'], ['Langley', 'BC'],
  // Alberta — Calgary, Edmonton + uni towns
  ['Calgary', 'AB'], ['Edmonton', 'AB'], ['Red Deer', 'AB'], ['Lethbridge', 'AB'],
  // Manitoba
  ['Winnipeg', 'MB'], ['Brandon', 'MB'],
  // Saskatchewan
  ['Saskatoon', 'SK'], ['Regina', 'SK'],
  // Atlantic — Halifax metro, NB triad, NL/PE capitals
  ['Halifax', 'NS'], ['Dartmouth', 'NS'], ['Sydney', 'NS'],
  ['Moncton', 'NB'], ['Saint John', 'NB'], ['Fredericton', 'NB'],
  ['St. Johns', 'NL'], ['Charlottetown', 'PE'],
  // Territorial capitals
  ['Whitehorse', 'YT'], ['Yellowknife', 'NT'], ['Iqaluit', 'NU'],
];

export default async function handler(req, res) {
  // Multi-format dispatch: ?format=rss or Accept: application/rss+xml → job feed
  // for aggregators (Indeed, ZipRecruiter, Jooble, Adzuna). Default = sitemap.xml
  // for search engines.
  const format = String(req.query.format || '').toLowerCase();
  const wantsRss = format === 'rss' || (req.headers.accept || '').includes('application/rss+xml');

  if (wantsRss) {
    return renderRssFeed(req, res);
  }

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');

  const base = 'https://www.canadayouthhire.ca';

  // Static pages
  // SPA: only include pages that render unique content without JS.
  // Other routes (about, contact, pricing, etc.) are JS-rendered from same index.html,
  // which Google sees as duplicates. Removed to fix Search Console "duplicate canonical" warnings.
  const staticPages = [
    { loc: '/', changefreq: 'daily', priority: '1.0' },
    { loc: '/locations', changefreq: 'daily', priority: '0.7' },
    { loc: '/employers', changefreq: 'daily', priority: '0.7' },
    { loc: '/about-youth-employment', changefreq: 'monthly', priority: '0.6' },
    { loc: '/status', changefreq: 'daily', priority: '0.3' },
    { loc: '/api', changefreq: 'monthly', priority: '0.5' },
  ];

  // Active jobs from DB — single fetch reused for /jobs/, /locations/, /employers/
  let jobs = [];
  try {
    const { data, error } = await sb.from('jobs')
      .select('job_id, title, company, loc, prov, created_at')
      .eq('status', 'active').order('created_at', { ascending: false }).limit(1000);
    if (error) console.error('sitemap DB error:', error.message);
    if (data) jobs = data;
  } catch (e) {
    console.error('sitemap job fetch error:', e.message);
  }

  // Per-job URLs
  const jobEntries = jobs.map(function(j) {
    const lastmod = j.created_at ? j.created_at.split('T')[0] : new Date().toISOString().split('T')[0];
    return `  <url>
    <loc>${base}/jobs/${j.job_id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
  });

  // Location landing URLs (distinct slug from normalized loc + prov,
  // avoiding "langford-bc-bc" when DB already encodes prov in `loc`).
  const locMap = new Map();
  for (const j of jobs) {
    if (!j.loc) continue;
    const norm = normalizeLoc(j.loc, j.prov);
    const slug = slugify(norm + (j.prov ? '-' + j.prov : ''));
    if (!slug) continue;
    const prev = locMap.get(slug);
    const lastmod = j.created_at ? j.created_at.split('T')[0] : null;
    if (!prev || (lastmod && lastmod > prev)) locMap.set(slug, lastmod);
  }

  // Pre-seed 47 major Canadian cities with high youth/student population so
  // the URLs are crawlable even before any employer posts there. The /locations/<slug>
  // renderer handles 0-active-jobs with a "check back" copy + stable URL, so an
  // empty page still absorbs "youth jobs in <city>" / "student jobs in <city>"
  // search intent. dedupe-against active-job slugs so we don't double-emit.
  for (const [city, prov] of PRE_SEED_CITIES) {
    const slug = slugify(city + '-' + prov);
    if (slug && !locMap.has(slug)) locMap.set(slug, null);
  }

  const locEntries = Array.from(locMap.entries()).map(function(entry) {
    const [slug, lastmod] = entry;
    return `  <url>
    <loc>${base}/locations/${slug}</loc>${lastmod ? '\n    <lastmod>' + lastmod + '</lastmod>' : ''}
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
  });

  // Employer landing URLs (distinct slug from company name)
  const empMap = new Map();
  for (const j of jobs) {
    if (!j.company) continue;
    const slug = slugify(j.company);
    if (!slug) continue;
    const prev = empMap.get(slug);
    const lastmod = j.created_at ? j.created_at.split('T')[0] : null;
    if (!prev || (lastmod && lastmod > prev)) empMap.set(slug, lastmod);
  }
  const empEntries = Array.from(empMap.entries()).map(function(entry) {
    const [slug, lastmod] = entry;
    return `  <url>
    <loc>${base}/employers/${slug}</loc>${lastmod ? '\n    <lastmod>' + lastmod + '</lastmod>' : ''}
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
  });

  // Fixed-axis landing pages — 13 provinces + 12 categories (see PROVINCE_SLUGS
  // and CATEGORY_SLUGS in api/job-page.js). These render even when 0 active jobs,
  // so we always emit them to keep stable indexed URLs.
  const provinceEntries = Object.keys(PROVINCE_SLUGS).map(function(slug) {
    return `  <url>
    <loc>${base}/jobs-in-${slug}</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>`;
  });
  const categoryEntries = Object.keys(CATEGORY_SLUGS).map(function(slug) {
    return `  <url>
    <loc>${base}/${slug}-jobs</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>`;
  });
  // Employment-type axis (5 fixed: full-time, part-time, contract, seasonal, casual).
  // Falls through the same `/:category-jobs` rewrite — handler resolves which axis.
  const employmentTypeEntries = Object.keys(EMPLOYMENT_TYPE_SLUGS).map(function(slug) {
    return `  <url>
    <loc>${base}/${slug}-jobs</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>`;
  });

  const staticXml = staticPages.map(function(p) {
    return `  <url>
    <loc>${base}${p.loc}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticXml}
${provinceEntries.join('\n')}
${categoryEntries.join('\n')}
${employmentTypeEntries.join('\n')}
${jobEntries.join('\n')}
${locEntries.join('\n')}
${empEntries.join('\n')}
</urlset>`;

  return res.status(200).send(xml);
}

/**
 * RSS 2.0 job feed for aggregator pickup.
 *
 * Submission targets (manual one-time setup — no API for most):
 *   - Indeed       (free posting program; provides feed URL on application)
 *   - ZipRecruiter (free aggregator tier; uses RSS or XML)
 *   - Jooble       (free aggregator; submit feed URL)
 *   - Adzuna       (Canada coverage; XML/RSS)
 *   - SimplyHired  (Indeed-owned, picks up from Indeed automatically)
 *   - Glassdoor    (LinkedIn-owned, picks up from LinkedIn Jobs)
 *
 * Format = RSS 2.0 with required elements (title, link, description, pubDate)
 * plus job-specific extensions when the aggregator supports them. Most Canadian
 * aggregators accept basic RSS — richer formats (HR-XML, Indeed XML) can be
 * added as a `?format=indeed` etc. variant later if needed.
 *
 * URL: /api/sitemap?format=rss  (or /feed.xml via vercel.json rewrite)
 */
async function renderRssFeed(req, res) {
  const base = 'https://www.canadayouthhire.ca';
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=300');

  let jobs = [];
  try {
    const { data } = await sb.from('jobs')
      .select('job_id, title, company, loc, prov, type, wage, category, remote, description, posted_date, created_at, exp_date, apply_method, apply_email, apply_url')
      .eq('status', 'active').order('created_at', { ascending: false }).limit(500);
    if (data) jobs = data;
  } catch (e) {
    console.error('rss feed fetch error:', e.message);
  }

  function rssEsc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function rfc822(d) {
    try { return new Date(d).toUTCString(); } catch (e) { return new Date().toUTCString(); }
  }

  // UTM tagging on <link> only — guid stays canonical (RFC: guid should be
  // a stable identifier, not a tracked URL). Aggregators that hyperlink the
  // <link> element auto-attribute traffic to the feed source.
  const UTM = '?utm_source=youthhire_feed&utm_medium=rss&utm_campaign=job_listing';
  const items = jobs.map(function(j) {
    const canonical  = `${base}/jobs/${j.job_id}`;
    const trackedUrl = canonical + UTM;
    const where = j.loc ? `${j.loc}${j.prov ? ', ' + j.prov : ''}` : (j.prov || 'Canada');
    const remoteTag = j.remote && /remote/i.test(j.remote) ? ' [Remote]' : '';
    const descParts = [
      j.company ? `Employer: ${j.company}` : null,
      `Location: ${where}${remoteTag}`,
      j.type ? `Type: ${j.type}` : null,
      j.wage ? `Compensation: ${j.wage}` : null,
      j.category ? `Category: ${j.category}` : null,
      '',
      (j.description || '').substring(0, 800),
    ].filter(function(p) { return p !== null; }).join('\n');
    return `    <item>
      <title>${rssEsc(j.title || 'Untitled')}${j.company ? ' - ' + rssEsc(j.company) : ''}</title>
      <link>${trackedUrl}</link>
      <guid isPermaLink="true">${canonical}</guid>
      <pubDate>${rfc822(j.created_at || j.posted_date || new Date())}</pubDate>
      <category>${rssEsc(j.category || 'Uncategorized')}</category>
      <description><![CDATA[${descParts}]]></description>
    </item>`;
  }).join('\n');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>YouthHire — Canada's Youth Job Board</title>
    <link>${base}</link>
    <atom:link href="${base}/feed.xml" rel="self" type="application/rss+xml" />
    <description>Entry-level, part-time, and first-job opportunities for students, new grads, and young workers across Canada.</description>
    <language>en-CA</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
  return res.status(200).send(rss);
}
