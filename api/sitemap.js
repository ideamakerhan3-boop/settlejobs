import { createClient } from '@supabase/supabase-js';
// Cross-import: pulls job-page.js into this function's bundle (~small size
// bump, no functional impact — see lessons/seo-landing-pages.md "함정 2").
// Keeps the slug whitelists DRY across renderer and sitemap.
import { PROVINCE_SLUGS, CATEGORY_SLUGS } from './job-page.js';

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

export default async function handler(req, res) {
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
${jobEntries.join('\n')}
${locEntries.join('\n')}
${empEntries.join('\n')}
</urlset>`;

  return res.status(200).send(xml);
}
