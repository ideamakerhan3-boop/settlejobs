import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Only fetch columns needed for SEO rendering
const JOB_COLS = 'job_id, title, company, loc, prov, type, wage, category, remote, lang, edu, exp_req, description, requirements, benefits, apply_method, apply_url, apply_email, posted_date, created_at, exp_date, status';

const BASE = 'https://www.canadayouthhire.ca';
const ORG_ID = `${BASE}/#organization`;

/**
 * Whitelisted province landing pages — 13 Canadian provinces/territories.
 * Slug = lowercased full name; value = { code, name } where code matches
 * `jobs.prov` (2-letter) and name is the display label.
 */
const PROVINCE_SLUGS = {
  'alberta':                    { code: 'AB', name: 'Alberta' },
  'british-columbia':           { code: 'BC', name: 'British Columbia' },
  'manitoba':                   { code: 'MB', name: 'Manitoba' },
  'new-brunswick':              { code: 'NB', name: 'New Brunswick' },
  'newfoundland-and-labrador':  { code: 'NL', name: 'Newfoundland and Labrador' },
  'nova-scotia':                { code: 'NS', name: 'Nova Scotia' },
  'northwest-territories':      { code: 'NT', name: 'Northwest Territories' },
  'nunavut':                    { code: 'NU', name: 'Nunavut' },
  'ontario':                    { code: 'ON', name: 'Ontario' },
  'prince-edward-island':       { code: 'PE', name: 'Prince Edward Island' },
  'quebec':                     { code: 'QC', name: 'Quebec' },
  'saskatchewan':               { code: 'SK', name: 'Saskatchewan' },
  'yukon':                      { code: 'YT', name: 'Yukon' }
};

/**
 * Whitelisted category landing pages — 12 categories from the admin form
 * (CAT_ICONS in index.html). "Other" is excluded — too generic to rank.
 * Slug → DB-stored category name (exact-match for filtering).
 */
const CATEGORY_SLUGS = {
  'hospitality-tourism':        'Hospitality & Tourism',
  'food-services':              'Food Services',
  'construction':               'Construction',
  'health-care':                'Health Care',
  'retail':                     'Retail',
  'transportation-logistics':   'Transportation & Logistics',
  'general-labour':             'General Labour',
  'child-care':                 'Child Care',
  'manufacturing':              'Manufacturing',
  'technology':                 'Technology',
  'education':                  'Education',
  'agriculture':                'Agriculture'
};

/**
 * Whitelisted employment-type landing pages — 5 types from the admin form.
 * Slug → DB-stored type (exact-match for `eq('type', dbName)`).
 * Falls through the same `/:category-jobs` rewrite — handler tries CATEGORY
 * first, then EMPLOYMENT_TYPE, then honest-404. Heavy search volume:
 * "part time jobs near me", "casual jobs canada", etc.
 */
const EMPLOYMENT_TYPE_SLUGS = {
  'full-time':  'Full-Time',
  'part-time':  'Part-Time',
  'contract':   'Contract',
  'seasonal':   'Seasonal',
  'casual':     'Casual',
};

export { PROVINCE_SLUGS, CATEGORY_SLUGS, EMPLOYMENT_TYPE_SLUGS };

/**
 * Multi-mode SEO renderer (single endpoint to stay under Vercel Hobby 12-function cap).
 *
 *   GET /jobs/:id          → renderJobDetail (bots get HTML, humans 302→SPA)
 *   GET /locations/:slug   → renderListingPage('location') for both bots and humans
 *   GET /employers/:slug   → renderListingPage('employer') for both bots and humans
 *
 * Listing pages target long-tail SEO ("jobs in vancouver bc", "jobs at city of X")
 * and are real public pages, so we do NOT bot-redirect them.
 */
// Bot UA patterns: search engines we care about for indexing + social embed
// crawlers we care about for share previews. AppleBot powers Siri/Spotlight.
// AhrefsBot/SemrushBot/MJ12bot are SEO tools that index our site for partner
// queries — letting them see the SSR HTML helps backlink graph + share-of-voice.
const BOT_RE = /bot|crawl|spider|slurp|Googlebot|Bingbot|DuckDuck|Yandex|Baidu|facebookexternalhit|Twitterbot|LinkedInBot|AhrefsBot|SemrushBot|MJ12bot|AppleBot/i;

export default async function handler(req, res) {
  const { id, type, slug } = req.query;

  if (type === 'location') {
    return slug
      ? renderListingPage('location', String(slug), req, res)
      : renderIndexPage('location', req, res);
  }
  if (type === 'employer') {
    return slug
      ? renderListingPage('employer', String(slug), req, res)
      : renderIndexPage('employer', req, res);
  }
  if (type === 'trust') {
    return renderTrustPage(req, res);
  }
  if (type === 'status') {
    return renderStatusPage(req, res);
  }
  if (type === 'apidocs') {
    return renderApiDocsPage(req, res);
  }
  if (type === 'province' && slug) {
    const meta = PROVINCE_SLUGS[String(slug).toLowerCase()];
    if (!meta) return renderHonest404(req, res, BASE + '/jobs-in-' + slug);
    return renderProvinceCategoryPage('province', String(slug).toLowerCase(), meta, req, res);
  }
  if (type === 'category' && slug) {
    // Order matters: CATEGORY first, then EMPLOYMENT_TYPE (both share the
    // `/:category-jobs` rewrite), then honest 404 + noindex (no soft-404 redirect).
    const slugLower = String(slug).toLowerCase();
    const catName = CATEGORY_SLUGS[slugLower];
    if (catName) return renderProvinceCategoryPage('category', slugLower, { dbName: catName }, req, res);
    const empType = EMPLOYMENT_TYPE_SLUGS[slugLower];
    if (empType) return renderProvinceCategoryPage('employment_type', slugLower, { dbName: empType, displayName: empType }, req, res);
    return renderHonest404(req, res, BASE + '/' + slug + '-jobs');
  }

  if (!id) return res.redirect(301, BASE + '/');

  // Server-side bot detection — real users go to the SPA immediately.
  // Must happen BEFORE any DB query (fast path for humans).
  // Cache-Control: no-store prevents CDN from serving this UA-variant response
  // to a different UA (e.g. bot response cached → served to human = broken UX).
  const ua = req.headers['user-agent'] || '';
  if (!BOT_RE.test(ua)) {
    return res.redirect(302, `${BASE}/?openJob=${id}`);
  }

  const { data: job } = await sb.from('jobs')
    .select(JOB_COLS)
    .eq('job_id', id)
    .maybeSingle();

  if (!job) {
    // Honest 404 instead of soft-404 redirect — likely a deleted/expired job
    // that Google still has in its crawl queue. 404+noindex tells Google to
    // drop it cleanly without diluting the rest of /jobs/* path family.
    return renderHonest404(req, res, BASE + '/jobs/' + id);
  }

  // ISO 8601 dates required by Google for Jobs
  const posted  = toISO(job.posted_date) || toISO(job.created_at) || new Date().toISOString().split('T')[0];
  const expires = toISO(job.exp_date) || '';

  // Detect expired posting (exp_date in the past)
  const isExpired = expires && new Date(expires) < new Date();

  const url   = BASE + '/jobs/' + id;
  // SEO best practice: keep <title> ~60 chars so Google SERP doesn't truncate
  // mid-word. Strategy: full "Title at Company — YouthHire" if it fits,
  // else drop the company, else hard-truncate the title itself.
  const SUFFIX = ' — YouthHire';
  const TITLE_MAX = 60;
  const room = TITLE_MAX - SUFFIX.length;
  let titleCore = esc(job.title) + ' at ' + esc(job.company);
  if (titleCore.length > room) {
    titleCore = esc(job.title);
    if (titleCore.length > room) {
      titleCore = titleCore.slice(0, room - 1) + '…';
    }
  }
  const title = titleCore + SUFFIX;
  const desc  = esc(job.title) + ' job in ' + esc(job.loc || 'Canada') + '. '
              + esc(job.type || 'Full-Time') + ' position at ' + esc(job.company)
              + '. Apply on YouthHire.';

  const jobDescHtml = descToHTML(job.description || job.title);
  const salary      = parseSalary(job.wage);

  // ── specialCommitments (Youth-specific signal for Google for Jobs) ──────────
  const specials = ['Youth Friendly'];
  if (!job.exp_req || job.exp_req === 'No experience') specials.push('No experience required');
  if (job.type && /part.time|student|casual/i.test(job.type)) specials.push('Students Welcome');

  // ── JobPosting JSON-LD ───────────────────────────────────────────────────────
  const jsonLdObj = {
    "@context": "https://schema.org",
    "@type":    "JobPosting",
    "title":       job.title,
    "description": jobDescHtml,
    "datePosted":  posted,
    "validThrough": expires || undefined,
    "employmentType": mapType(job.type),
    "specialCommitments": specials.join(', '),
    "identifier": {
      "@type": "PropertyValue",
      "name":  "YouthHire",
      "value": String(id)
    },
    "hiringOrganization": {
      "@type": "Organization",
      "@id":   ORG_ID,
      "name":  job.company,
      "sameAs": BASE
    },
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type":           "PostalAddress",
        // De-duplicate: stored `loc` is "Vernon, BC" form, but addressRegion
        // already carries the province. Emitting "Vernon, BC" + "BC" makes
        // Google's schema validator flag a duplicate. Strip trailing 2-letter
        // province (with optional comma + space) from addressLocality.
        // Prefer biz_city when present (already province-free).
        "addressLocality": job.biz_city || String(job.loc || '').replace(/,\s*[A-Z]{2}\s*$/, '').trim(),
        "addressRegion":   job.prov || job.biz_prov || '',
        "addressCountry":  "CA"
      }
    },
    "directApply": false,
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id":   url
    }
  };

  // baseSalary
  if (salary) {
    jsonLdObj.baseSalary = { "@type": "MonetaryAmount", "currency": "CAD", "value": salary };
  }

  // Remote / onsite
  // Google for Jobs: jobLocationType only accepts 'TELECOMMUTE'.
  // For onsite roles, omit the field entirely (do NOT use 'ONSITE' — invalid enum).
  if (job.remote === 'remote' || job.remote === 'Remote') {
    jsonLdObj.jobLocationType = 'TELECOMMUTE';
    jsonLdObj.applicantLocationRequirements = { "@type": "Country", "name": "Canada" };
  }

  // Education — credentialCategory must be a valid Google enum
  // (high school | associate degree | bachelor degree | postgraduate degree | professional certificate)
  const eduEnum = mapEduToCredential(job.edu);
  if (eduEnum) {
    jsonLdObj.educationRequirements = {
      "@type": "EducationalOccupationalCredential",
      "credentialCategory": eduEnum
    };
  }

  // Experience — must be OccupationalExperienceRequirements with monthsOfExperience
  const expMonths = mapExpToMonths(job.exp_req);
  if (expMonths !== null) {
    jsonLdObj.experienceRequirements = {
      "@type": "OccupationalExperienceRequirements",
      "monthsOfExperience": expMonths
    };
  }

  // Benefits (first 200 chars from DB benefits field)
  if (job.benefits) {
    jsonLdObj.jobBenefits = job.benefits.replace(/\n/g, ', ').substring(0, 200);
  }

  // applicationContact
  if (job.apply_method === 'email' && job.apply_email) {
    jsonLdObj.applicationContact = {
      "@type": "ContactPoint",
      "email": job.apply_email,
      "contactType": "application"
    };
  } else if (job.apply_method === 'url' && job.apply_url && !isUnsafeUri(job.apply_url)) {
    jsonLdObj.applicationContact = {
      "@type": "ContactPoint",
      "url":   job.apply_url,
      "contactType": "application"
    };
  }

  const jsonLd = JSON.stringify(jsonLdObj).replace(/<\//g, '<\\/');

  // ── BreadcrumbList JSON-LD ───────────────────────────────────────────────────
  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type":    "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE },
      { "@type": "ListItem", "position": 2, "name": "Jobs", "item": BASE + "/" },
      { "@type": "ListItem", "position": 3, "name": job.title + " at " + job.company, "item": url }
    ]
  }).replace(/<\//g, '<\\/');

  // Sanitize apply_url
  const safeApplyUrl   = job.apply_url && !isUnsafeUri(job.apply_url) ? esc(job.apply_url) : '';
  const jobDescEscaped = esc((job.description || '').substring(0, 500));

  // Robots: noindex for expired postings (keeps link equity via follow)
  const robotsContent = isExpired ? 'noindex, follow' : 'index, follow';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en-CA" href="${url}">
<link rel="alternate" hreflang="x-default" href="${url}">
<meta name="robots" content="${robotsContent}">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<meta property="og:locale" content="en_CA">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<script type="application/ld+json">${jsonLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.6}
h1{color:#2563EB;font-size:28px;margin-bottom:4px}
.company{font-size:20px;font-weight:700;margin-bottom:16px}
.meta{color:#5A5A5A;font-size:14px;margin-bottom:24px}
.meta span{margin-right:16px}
.desc{white-space:pre-wrap;margin-bottom:32px}
.cta{display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px}
.expired-banner{background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-weight:600;color:#92400E}
.footer{margin-top:48px;padding-top:20px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
a{color:#2563EB}
</style>
</head>
<body>
<nav style="margin-bottom:32px">
<a href="${BASE}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<a href="${BASE}">All Jobs</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>${esc(job.title)}</span>
</nav>

${isExpired ? '<div class="expired-banner">⚠️ This job posting has expired. Browse current openings on <a href="' + BASE + '">YouthHire</a>.</div>' : ''}

<h1>${esc(job.title)}</h1>
<div class="company">${esc(job.company)}</div>
<div class="meta">
<span>📍 ${esc(normalizeLoc(job.loc, job.prov) || job.loc || 'Canada')}${job.prov ? ', ' + esc(job.prov) : ''}</span>
<span>💼 ${esc(job.type || 'Full-Time')}</span>
${job.wage ? '<span>💰 ' + esc(job.wage) + '</span>' : ''}
${job.category ? '<span>📂 ' + esc(job.category) + '</span>' : ''}
${job.remote && job.remote !== 'onsite' ? '<span>🏠 ' + esc(job.remote) + '</span>' : ''}
${job.lang && job.lang !== 'English' ? '<span>🌐 ' + esc(job.lang) + '</span>' : ''}
</div>
${(job.edu && job.edu !== 'None') || (job.exp_req && job.exp_req !== 'No experience') ? '<p style="font-size:13px;color:#5A5A5A;margin-bottom:8px">' + (job.edu && job.edu !== 'None' ? '🎓 ' + esc(job.edu) : '') + (job.exp_req && job.exp_req !== 'No experience' ? ' · 📋 ' + esc(job.exp_req) : '') + '</p>' : ''}
${posted ? '<p style="font-size:13px;color:#919191">Posted: ' + esc(posted) + (expires ? ' · Expires: ' + esc(expires) : '') + '</p>' : ''}

<div class="desc">${jobDescEscaped}${job.description && job.description.length > 500 ? '...' : ''}</div>
${job.requirements ? '<h3 style="margin:16px 0 8px;font-size:16px">Requirements</h3><ul>' + job.requirements.split(/\r?\n/).filter(s => s.trim()).map(r => '<li>' + esc(r.trim()) + '</li>').join('') + '</ul>' : ''}
${job.benefits ? '<h3 style="margin:16px 0 8px;font-size:16px">Benefits</h3><ul>' + job.benefits.split(/\r?\n/).filter(s => s.trim()).map(b => '<li>' + esc(b.trim()) + '</li>').join('') + '</ul>' : ''}

${job.apply_method === 'url' && safeApplyUrl ? '<p style="margin:16px 0"><strong>Apply:</strong> <a href="' + safeApplyUrl + '" style="color:#2563EB;font-weight:700">' + safeApplyUrl + '</a></p>' : ''}
${job.apply_method === 'email' && job.apply_email ? '<p style="margin:16px 0"><strong>Apply:</strong> <a href="mailto:' + esc(job.apply_email) + '" style="color:#2563EB;font-weight:700">' + esc(job.apply_email) + '</a></p>' : ''}
${!isExpired ? '<a href="' + BASE + '/#detail-' + id + '" class="cta">View Full Posting & Apply →</a>' : '<a href="' + BASE + '" class="cta">Browse Current Jobs →</a>'}

<div class="footer">
<p style="margin-bottom:12px"><strong>More opportunities</strong></p>
<p style="margin-bottom:12px">${job.loc ? '<a href="' + BASE + '/locations/' + slugify(normalizeLoc(job.loc, job.prov) + (job.prov ? '-' + job.prov : '')) + '">More jobs in ' + esc(normalizeLoc(job.loc, job.prov)) + (job.prov ? ', ' + esc(job.prov) : '') + '</a>' : ''}${job.loc && job.company ? ' · ' : ''}${job.company ? '<a href="' + BASE + '/employers/' + slugify(job.company) + '">More jobs at ' + esc(job.company) + '</a>' : ''}</p>
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p><a href="${BASE}/about">About</a> · <a href="${BASE}/contact">Contact</a> · <a href="${BASE}/privacy">Privacy</a> · <a href="${BASE}/terms">Terms</a></p>
</div>

</body>
</html>`;

  // no-store: response varies by User-Agent (bot→HTML, human→302).
  // Sharing a cached response across UAs breaks bot detection, so we never cache at CDN.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isUnsafeUri(uri) {
  if (!uri) return true;
  const lower = uri.trim().toLowerCase();
  return lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:');
}

/**
 * Convert any date string to ISO 8601 YYYY-MM-DD.
 * Handles: "2026-05-03", "2026-05-03T...", "May 3, 2026", "Jul 2, 2026" etc.
 */
function toISO(s) {
  if (!s) return '';
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return '';
}

/**
 * Convert plain-text description to minimal HTML for Google for Jobs.
 */
function descToHTML(text) {
  if (!text) return '';
  return text.split(/\n{2,}/)
    .map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>')
    .join('');
}

/**
 * Parse wage string like "$22 – $27/hr", "$50,000/yr" into QuantitativeValue.
 * Returns null if unparseable.
 */
function parseSalary(wage) {
  if (!wage) return null;
  const s = String(wage);
  let unitText = 'HOUR';
  if (/\byr\b|year|annual/i.test(s)) unitText = 'YEAR';
  else if (/\bmo\b|month/i.test(s)) unitText = 'MONTH';
  else if (/\bwk\b|week/i.test(s)) unitText = 'WEEK';
  else if (/\bday\b/i.test(s)) unitText = 'DAY';
  const nums = s.replace(/[$,]/g, '').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  const values = nums.map(Number);
  if (values.length === 1) {
    return { "@type": "QuantitativeValue", "value": values[0], "unitText": unitText };
  }
  return { "@type": "QuantitativeValue", "minValue": Math.min(...values), "maxValue": Math.max(...values), "unitText": unitText };
}

function mapType(t) {
  if (!t) return 'FULL_TIME';
  const l = t.toLowerCase();
  if (l.includes('part')) return 'PART_TIME';
  if (l.includes('contract')) return 'CONTRACTOR';
  if (l.includes('temp')) return 'TEMPORARY';
  if (l.includes('intern')) return 'INTERN';
  if (l.includes('seasonal') || l.includes('season')) return 'SEASONAL';
  if (l.includes('casual')) return 'PART_TIME';
  return 'FULL_TIME';
}

/**
 * Map admin-form education values to Google for Jobs `credentialCategory` enum.
 * Valid enum: "high school" | "associate degree" | "bachelor degree"
 *           | "postgraduate degree" | "professional certificate"
 * Returns null when no education requirement should be emitted.
 */
function mapEduToCredential(edu) {
  if (!edu || edu === 'None') return null;
  const l = String(edu).toLowerCase();
  if (l.includes('high school') || l.includes('ged')) return 'high school';
  if (l.includes('college') || l.includes('associate') || l.includes('diploma')) return 'associate degree';
  if (l.includes('bachelor') || l.includes('university')) return 'bachelor degree';
  if (l.includes('master') || l.includes('phd') || l.includes('doctor') || l.includes('postgrad')) return 'postgraduate degree';
  if (l.includes('certificate') || l.includes('cert')) return 'professional certificate';
  return null;
}

/**
 * Map admin-form experience strings to `monthsOfExperience` for
 * OccupationalExperienceRequirements. Returns null when no requirement.
 */
function mapExpToMonths(exp) {
  if (!exp || exp === 'No experience') return null;
  const l = String(exp).toLowerCase();
  if (l.includes('less than 1') || l.includes('<1')) return 6;
  if (/\b1[\s\-–]*2\b/.test(l)) return 12;
  if (/\b3[\s\-–]*5\b/.test(l)) return 36;
  if (/\b5\+/.test(l) || /\b5 or more\b/.test(l)) return 60;
  // Fallback: extract leading number, treat as years
  const m = l.match(/(\d+)/);
  if (m) return Number(m[1]) * 12;
  return null;
}

/**
 * Strip a trailing province code from a location string when the prov column
 * already encodes it (DB has both "Langford, BC" + prov="BC" → "Langford").
 * Prevents duplicated display ("Langford, BC, BC") and bloated slugs ("langford-bc-bc").
 */
function normalizeLoc(loc, prov) {
  if (!loc) return '';
  if (!prov) return String(loc).trim();
  const re = new RegExp(',?\\s*' + String(prov).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
  return String(loc).replace(re, '').trim();
}

/**
 * Slugify a string into a URL-safe segment.
 * "Vancouver, BC" → "vancouver-bc"
 * "City of Vancouver" → "city-of-vancouver"
 */
function slugify(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

/**
 * Render a top-level browse index — `/locations` lists every distinct city
 * with job counts, `/employers` lists every distinct company. Completes the
 * crawl graph (BreadcrumbList JSON-LD on listing pages references these URLs)
 * and gives Google a hub page tying the long-tail matrix together.
 */
async function renderIndexPage(type, req, res) {
  const LIST_COLS = 'job_id, company, loc, prov, status';
  const { data: jobs } = await sb.from('jobs')
    .select(LIST_COLS)
    .eq('status', 'active')
    .limit(2000);

  // Group by slug, capturing display name and count
  const groups = new Map();  // slug → { name, count }
  for (const j of (jobs || [])) {
    let slug, name;
    if (type === 'location') {
      if (!j.loc) continue;
      const norm = normalizeLoc(j.loc, j.prov);
      slug = slugify(norm + (j.prov ? '-' + j.prov : ''));
      name = norm + (j.prov ? ', ' + j.prov : '');
    } else {
      if (!j.company) continue;
      slug = slugify(j.company);
      name = j.company;
    }
    if (!slug) continue;
    const prev = groups.get(slug);
    if (prev) prev.count++;
    else groups.set(slug, { name, count: 1 });
  }

  // Sort alphabetically by display name
  const sorted = Array.from(groups.entries())
    .map(([slug, info]) => ({ slug, ...info }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const url = BASE + (type === 'location' ? '/locations' : '/employers');
  const pageTitle = type === 'location'
    ? 'Browse jobs by city — YouthHire'
    : 'Browse jobs by employer — YouthHire';
  const pageDesc = type === 'location'
    ? `Find youth jobs in ${sorted.length} ${sorted.length === 1 ? 'city' : 'cities'} across Canada. Entry-level, part-time, and first-job opportunities for students and new grads.`
    : `Browse youth job openings from ${sorted.length} Canadian ${sorted.length === 1 ? 'employer' : 'employers'}. Entry-level, part-time, and first-job opportunities.`;
  const h1 = type === 'location' ? 'Jobs by city' : 'Jobs by employer';

  const itemListLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    "itemListElement": sorted.slice(0, 200).map((g, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "url": BASE + (type === 'location' ? '/locations/' : '/employers/') + g.slug,
      "name": g.name
    }))
  }).replace(/<\//g, '<\\/');

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE },
      { "@type": "ListItem", "position": 2, "name": type === 'location' ? "Locations" : "Employers", "item": url }
    ]
  }).replace(/<\//g, '<\\/');

  // Group cities by province for nicer browsing (locations only)
  let listHtml;
  if (type === 'location') {
    const byProv = new Map();
    for (const g of sorted) {
      const provMatch = g.name.match(/, ([A-Z]{2})$/);
      const provKey = provMatch ? provMatch[1] : 'Other';
      if (!byProv.has(provKey)) byProv.set(provKey, []);
      byProv.get(provKey).push(g);
    }
    listHtml = Array.from(byProv.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([prov, items]) => `<section style="margin-bottom:32px">
  <h2 style="font-size:18px;margin:0 0 12px;color:#0F0F0F">${esc(prov)}</h2>
  <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
${items.map(g => `    <li><a href="${BASE}/locations/${g.slug}" style="color:#2563EB;text-decoration:none">${esc(g.name.replace(/, [A-Z]{2}$/, ''))}</a> <span style="color:#919191">(${g.count})</span></li>`).join('\n')}
  </ul>
</section>`).join('\n');
  } else {
    listHtml = `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">
${sorted.map(g => `  <li><a href="${BASE}/employers/${g.slug}" style="color:#2563EB;text-decoration:none">${esc(g.name)}</a> <span style="color:#919191">(${g.count})</span></li>`).join('\n')}
</ul>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en-CA" href="${url}">
<link rel="alternate" hreflang="x-default" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<meta property="og:locale" content="en_CA">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(pageDesc)}">
<script type="application/ld+json">${itemListLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.6}
h1{color:#2563EB;font-size:28px;margin-bottom:4px}
.lede{color:#5A5A5A;margin-bottom:32px}
nav{margin-bottom:32px;font-size:14px}
.cta{display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:24px 0}
.footer{margin-top:48px;padding-top:20px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<nav>
<a href="${BASE}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>${type === 'location' ? 'Locations' : 'Employers'}</span>
</nav>

<h1>${h1}</h1>
<p class="lede">${sorted.length} ${type === 'location' ? (sorted.length === 1 ? 'city' : 'cities') : (sorted.length === 1 ? 'employer' : 'employers')} with active openings. ${type === 'location' ? 'See <a href="' + BASE + '/employers">employers</a>.' : 'See <a href="' + BASE + '/locations">locations</a>.'}</p>

${listHtml || '<p style="color:#5A5A5A">No active openings yet.</p>'}

<a href="${BASE}" class="cta">Browse all jobs →</a>

<div class="footer">
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p><a href="${BASE}/about">About</a> · <a href="${BASE}/contact">Contact</a> · <a href="${BASE}/privacy">Privacy</a> · <a href="${BASE}/terms">Terms</a></p>
</div>

</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=120');
  return res.status(200).send(html);
}

/**
 * Render a long-tail SEO landing page that lists active jobs filtered by
 * location ("vancouver-bc") or employer ("city-of-vancouver").
 *
 * Single-query strategy: fetch all active jobs (capped at 1000) and group
 * by slugified key client-side. This is cheap at our scale (<500 jobs) and
 * lets the same query feed sitemap.js without schema changes.
 *
 * Renders the same HTML for bots and humans (no UA branching) — these are
 * real public pages, not bot-only crawl targets.
 */
async function renderListingPage(type, slug, req, res) {
  const cleanSlug = slugify(slug);  // defend against junk input
  if (!cleanSlug) return renderHonest404(req, res, BASE + '/' + (type === 'location' ? 'locations' : 'employers') + '/' + slug);

  const LIST_COLS = 'job_id, title, company, loc, prov, type, wage, category, remote, posted_date, created_at, exp_date, status';
  const { data: jobs } = await sb.from('jobs')
    .select(LIST_COLS)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (!jobs || jobs.length === 0) {
    return renderEmptyListing(type, cleanSlug, res);
  }

  // Filter to jobs whose slug matches the requested one.
  // For locations we accept BOTH the normalized slug (vancouver-bc) and the
  // legacy double-encoded slug (vancouver-bc-bc) so old sitemap URLs cached
  // at the edge keep resolving during the rollover window.
  const matched = jobs.filter(j => {
    if (type === 'location') {
      const norm = normalizeLoc(j.loc, j.prov);
      const newSlug    = slugify(norm + (j.prov ? '-' + j.prov : ''));
      const legacySlug = slugify((j.loc || '') + (j.prov ? '-' + j.prov : ''));
      return newSlug === cleanSlug || legacySlug === cleanSlug;
    } else {
      return slugify(j.company || '') === cleanSlug;
    }
  });

  if (matched.length === 0) {
    return renderEmptyListing(type, cleanSlug, res);
  }

  // Derive display name from the first matched row (DB is source of truth).
  // Strip duplicate province encoded in `loc` (DB has both "Langford, BC" + prov="BC").
  const sample = matched[0];
  const displayName = type === 'location'
    ? normalizeLoc(sample.loc, sample.prov) + (sample.prov ? ', ' + sample.prov : '')
    : (sample.company || cleanSlug);

  const url = BASE + (type === 'location' ? '/locations/' : '/employers/') + cleanSlug;
  const pageTitle = type === 'location'
    ? `Jobs in ${displayName} — YouthHire`
    : `Jobs at ${displayName} — YouthHire`;
  const pageDesc = `${matched.length} active youth ${matched.length === 1 ? 'job' : 'jobs'} ${type === 'location' ? 'in' : 'at'} ${displayName}. Entry-level, part-time, and first-job opportunities for students, new grads, and young workers in Canada.`;

  // ItemList JSON-LD aggregating the JobPosting links
  const itemListLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    "itemListElement": matched.slice(0, 50).map((j, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "url": BASE + '/jobs/' + j.job_id
    }))
  }).replace(/<\//g, '<\\/');

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE },
      { "@type": "ListItem", "position": 2, "name": type === 'location' ? "Locations" : "Employers", "item": BASE + (type === 'location' ? '/locations' : '/employers') },
      { "@type": "ListItem", "position": 3, "name": displayName, "item": url }
    ]
  }).replace(/<\//g, '<\\/');

  const cardsHtml = matched.slice(0, 50).map(j => {
    const normLoc = normalizeLoc(j.loc, j.prov);
    const otherSlug = type === 'location'
      ? slugify(j.company || '')
      : slugify(normLoc + (j.prov ? '-' + j.prov : ''));
    const otherLink = type === 'location'
      ? (j.company ? '<a href="' + BASE + '/employers/' + otherSlug + '">' + esc(j.company) + '</a>' : '')
      : (j.loc ? '<a href="' + BASE + '/locations/' + otherSlug + '">' + esc(normLoc) + (j.prov ? ', ' + esc(j.prov) : '') + '</a>' : '');
    return `<li class="card">
  <a href="${BASE}/jobs/${j.job_id}" class="card-title">${esc(j.title)}</a>
  <div class="card-meta">${otherLink}${j.type ? ' · ' + esc(j.type) : ''}${j.wage ? ' · ' + esc(j.wage) : ''}${j.remote && /remote/i.test(j.remote) ? ' · 🏠 Remote' : ''}</div>
</li>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en-CA" href="${url}">
<link rel="alternate" hreflang="x-default" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<meta property="og:locale" content="en_CA">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(pageDesc)}">
<script type="application/ld+json">${itemListLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.6}
h1{color:#2563EB;font-size:28px;margin-bottom:4px}
.lede{color:#5A5A5A;margin-bottom:32px}
ul.cards{list-style:none;padding:0;margin:0}
.card{padding:16px;border:1px solid #E2E2DC;border-radius:10px;margin-bottom:12px;transition:border-color .15s}
.card:hover{border-color:#2563EB}
.card-title{font-weight:700;font-size:17px;color:#2563EB;text-decoration:none}
.card-title:hover{text-decoration:underline}
.card-meta{font-size:13px;color:#5A5A5A;margin-top:4px}
.card-meta a{color:#5A5A5A;text-decoration:underline}
nav{margin-bottom:32px;font-size:14px}
.cta{display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:24px 0}
.footer{margin-top:48px;padding-top:20px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
a{color:#2563EB}
</style>
</head>
<body>
<nav>
<a href="${BASE}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>${type === 'location' ? 'Jobs in' : 'Jobs at'} ${esc(displayName)}</span>
</nav>

<h1>${type === 'location' ? 'Jobs in' : 'Jobs at'} ${esc(displayName)}</h1>
<p class="lede">${matched.length} active ${matched.length === 1 ? 'opening' : 'openings'} for students, new grads, and young workers.</p>

<ul class="cards">
${cardsHtml}
</ul>

${matched.length > 50 ? '<p style="color:#5A5A5A;font-size:14px;margin-top:24px">Showing the 50 most recent. <a href="' + BASE + '">Browse all jobs →</a></p>' : ''}

<a href="${BASE}" class="cta">Browse all jobs →</a>

<div class="footer">
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p><a href="${BASE}/about">About</a> · <a href="${BASE}/contact">Contact</a> · <a href="${BASE}/privacy">Privacy</a> · <a href="${BASE}/terms">Terms</a></p>
</div>

</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Edge-cache for 5 minutes; revalidate in background. Safe because content
  // is identical for bots and humans (no UA-variant response).
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  return res.status(200).send(html);
}

/**
 * Render a province- or category-filtered landing page.
 *   /jobs-in-:province  → 13 fixed pages (lessons/seo-landing-pages.md "TIJ pattern")
 *   /:category-jobs     → 12 fixed pages (Hospitality & Tourism, etc.)
 *
 * Compared to renderListingPage (location/employer = dynamic N×M):
 *   - Slug whitelist gates unknown values to 302 home (no empty index pages)
 *   - Renders even when 0 active jobs (with "check back" copy) — fixed-axis
 *     pages are stable URLs we want indexed even on empty days
 *   - CollectionPage + ItemList JSON-LD (matches TIJ schema convention)
 *   - Cross-axis links: province pages link to all 12 categories, vice-versa
 */
async function renderProvinceCategoryPage(type, slug, meta, req, res) {
  const LIST_COLS = 'job_id, title, company, loc, prov, type, wage, category, remote, posted_date, created_at, exp_date, status';

  let query = sb.from('jobs').select(LIST_COLS).eq('status', 'active');
  if (type === 'province') {
    query = query.eq('prov', meta.code);
  } else if (type === 'employment_type') {
    query = query.eq('type', meta.dbName);
  } else {
    query = query.eq('category', meta.dbName);
  }
  const { data: matched } = await query
    .order('created_at', { ascending: false })
    .limit(100);

  const jobs = matched || [];
  const displayName = type === 'province' ? meta.name : meta.dbName;
  const url = BASE + (
    type === 'province' ? '/jobs-in-' + slug
    : '/' + slug + '-jobs'  // both 'category' and 'employment_type' use this format
  );

  let pageTitle, pageDesc, h1;
  if (type === 'province') {
    pageTitle = `Youth Jobs in ${displayName} — YouthHire`;
    pageDesc  = `${jobs.length} active youth ${jobs.length === 1 ? 'job' : 'jobs'} in ${displayName}. Entry-level, part-time, and first-job opportunities for students, new grads, and young workers.`;
    h1        = `Youth jobs in ${displayName}`;
  } else if (type === 'employment_type') {
    pageTitle = `${displayName} Youth Jobs — YouthHire`;
    pageDesc  = `${jobs.length} active ${displayName.toLowerCase()} ${jobs.length === 1 ? 'job' : 'jobs'} for youth across Canada. ${displayName === 'Casual' ? 'Flexible on-call work' : displayName === 'Seasonal' ? 'Summer and seasonal work' : displayName} for students, new grads, and young workers.`;
    h1        = `${displayName} jobs for youth`;
  } else {
    pageTitle = `${displayName} Jobs — YouthHire`;
    pageDesc  = `${jobs.length} active ${displayName.toLowerCase()} ${jobs.length === 1 ? 'job' : 'jobs'} for youth across Canada. Entry-level, part-time, and first-job opportunities for students and new grads.`;
    h1        = `${displayName} jobs for youth`;
  }

  // CollectionPage wrapper (richer than bare ItemList — TIJ schema convention).
  // ItemList.itemListElement uses ListItem(position+url+name) only — do NOT
  // re-emit JobPosting here; the full schema lives at /jobs/:id and Google
  // would otherwise dedupe/confuse cross-page citations.
  const collectionLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": url,
    "url": url,
    "name": pageTitle,
    "description": pageDesc,
    "isPartOf": { "@type": "WebSite", "@id": BASE + "/#website", "url": BASE, "name": "YouthHire" },
    "mainEntity": {
      "@type": "ItemList",
      "numberOfItems": jobs.length,
      "itemListElement": jobs.slice(0, 50).map((j, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "url": BASE + '/jobs/' + j.job_id,
        "name": j.title
      }))
    }
  }).replace(/<\//g, '<\\/');

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE },
      { "@type": "ListItem", "position": 2, "name": displayName, "item": url }
    ]
  }).replace(/<\//g, '<\\/');

  // Cross-axis links — distributes link equity across the 30-page matrix
  // (13 provinces + 12 categories + 5 employment types). province pages link
  // to category+employment-type, etc. Always cross to OTHER axes, not own axis.
  function chip(href, text) {
    return `<a href="${href}" style="color:#5A5A5A;font-size:13px;margin:0 8px 4px 0;display:inline-block">${esc(text)}</a>`;
  }
  const provinceChips      = Object.entries(PROVINCE_SLUGS).map(([s, m]) => chip(`${BASE}/jobs-in-${s}`, m.name)).join('');
  const categoryChips      = Object.entries(CATEGORY_SLUGS).map(([s, n]) => chip(`${BASE}/${s}-jobs`, n)).join('');
  const employmentChips    = Object.entries(EMPLOYMENT_TYPE_SLUGS).map(([s, n]) => chip(`${BASE}/${s}-jobs`, n)).join('');
  let crossLinks, crossLinksHeading;
  if (type === 'province') {
    crossLinks = `<div style="margin-bottom:12px"><strong style="font-size:13px;color:#5A5A5A">By category:</strong> ${categoryChips}</div><div><strong style="font-size:13px;color:#5A5A5A">By type:</strong> ${employmentChips}</div>`;
    crossLinksHeading = 'Refine your search';
  } else if (type === 'employment_type') {
    crossLinks = `<div style="margin-bottom:12px"><strong style="font-size:13px;color:#5A5A5A">By province:</strong> ${provinceChips}</div><div><strong style="font-size:13px;color:#5A5A5A">By category:</strong> ${categoryChips}</div>`;
    crossLinksHeading = 'Refine your search';
  } else {
    // category
    crossLinks = `<div style="margin-bottom:12px"><strong style="font-size:13px;color:#5A5A5A">By province:</strong> ${provinceChips}</div><div><strong style="font-size:13px;color:#5A5A5A">By type:</strong> ${employmentChips}</div>`;
    crossLinksHeading = 'Refine your search';
  }

  const cardsHtml = jobs.length > 0
    ? jobs.slice(0, 50).map(j => {
        const normLoc = normalizeLoc(j.loc, j.prov);
        return `<li class="card">
  <a href="${BASE}/jobs/${j.job_id}" class="card-title">${esc(j.title)}</a>
  <div class="card-meta">${j.company ? esc(j.company) + ' · ' : ''}${normLoc ? esc(normLoc) + (j.prov ? ', ' + esc(j.prov) : '') : ''}${j.type ? ' · ' + esc(j.type) : ''}${j.wage ? ' · ' + esc(j.wage) : ''}${j.remote && /remote/i.test(j.remote) ? ' · 🏠 Remote' : ''}</div>
</li>`;
      }).join('\n')
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en-CA" href="${url}">
<link rel="alternate" hreflang="x-default" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<meta property="og:locale" content="en_CA">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(pageDesc)}">
<script type="application/ld+json">${collectionLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.6}
h1{color:#2563EB;font-size:28px;margin-bottom:4px}
.lede{color:#5A5A5A;margin-bottom:32px}
ul.cards{list-style:none;padding:0;margin:0}
.card{padding:16px;border:1px solid #E2E2DC;border-radius:10px;margin-bottom:12px;transition:border-color .15s}
.card:hover{border-color:#2563EB}
.card-title{font-weight:700;font-size:17px;color:#2563EB;text-decoration:none}
.card-title:hover{text-decoration:underline}
.card-meta{font-size:13px;color:#5A5A5A;margin-top:4px}
nav{margin-bottom:32px;font-size:14px}
.cta{display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:24px 0}
.empty{padding:32px;border:1px dashed #E2E2DC;border-radius:10px;text-align:center;color:#5A5A5A;margin:24px 0}
.cross{margin-top:48px;padding:20px;background:#FAFAF7;border-radius:10px}
.cross h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#5A5A5A;margin:0 0 12px;font-weight:600}
.footer{margin-top:48px;padding-top:20px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
a{color:#2563EB}
</style>
</head>
<body>
<nav>
<a href="${BASE}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>${esc(displayName)}</span>
</nav>

<h1>${esc(h1)}</h1>
<p class="lede">${jobs.length === 0 ? 'No active openings right now — check back soon, or browse all current jobs.' : `${jobs.length} active ${jobs.length === 1 ? 'opening' : 'openings'} for students, new grads, and young workers.`}</p>

${cardsHtml ? `<ul class="cards">\n${cardsHtml}\n</ul>` : '<div class="empty">No openings yet — <a href="' + BASE + '">browse all jobs</a> or check back soon.</div>'}

${jobs.length > 50 ? '<p style="color:#5A5A5A;font-size:14px;margin-top:24px">Showing the 50 most recent. <a href="' + BASE + '">Browse all jobs →</a></p>' : ''}

<a href="${BASE}" class="cta">Browse all jobs →</a>

<section class="cross">
<h2>${crossLinksHeading}</h2>
${crossLinks}
</section>

<div class="footer">
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p><a href="${BASE}/about">About</a> · <a href="${BASE}/contact">Contact</a> · <a href="${BASE}/privacy">Privacy</a> · <a href="${BASE}/terms">Terms</a></p>
</div>

</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=120');
  return res.status(200).send(html);
}

/**
 * Public REST API documentation page at /api.
 *
 * Server-rendered HTML with APIDocumentation JSON-LD so search engines and
 * AI assistants can surface the endpoints. Indexable. Targets developers /
 * partners (university career portals, aggregator integrators) who want to
 * pull our active jobs into their own systems.
 */
function renderApiDocsPage(req, res) {
  const url = BASE + '/api';
  const pageTitle = "Public API — YouthHire";
  const pageDesc = "Free public REST API for partners. Pull YouthHire's active youth jobs into your career portal, aggregator, or community newsletter. JSON, no auth required.";

  const apiDocLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "APIReference",
    "@id": url,
    "name": pageTitle,
    "description": pageDesc,
    "url": url,
    "isPartOf": { "@type": "WebSite", "@id": BASE + "/#website", "url": BASE, "name": "YouthHire" },
    "audience": { "@type": "Audience", "audienceType": "Developers, partner integrators" },
    "documentation": url,
  }).replace(/<\//g, '<\\/');

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE },
      { "@type": "ListItem", "position": 2, "name": "API", "item": url }
    ]
  }).replace(/<\//g, '<\\/');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en-CA" href="${url}">
<link rel="alternate" hreflang="x-default" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<script type="application/ld+json">${apiDocLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:880px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.7}
h1{color:#2563EB;font-size:32px;margin-bottom:8px;letter-spacing:-.02em}
h2{font-size:21px;margin:36px 0 12px;letter-spacing:-.01em}
h3{font-size:16px;margin:18px 0 8px}
.lede{color:#5A5A5A;font-size:17px;margin-bottom:36px;line-height:1.6}
nav{margin-bottom:32px;font-size:14px}
.endpoint{padding:18px 20px;border:1px solid #E2E2DC;border-radius:12px;margin:14px 0;background:#FAFAF7}
.method{display:inline-block;padding:3px 10px;border-radius:6px;font-weight:700;font-size:12px;letter-spacing:.5px;background:#10B981;color:#fff;margin-right:8px}
.path{font-family:'JetBrains Mono',Menlo,monospace;font-size:14px;font-weight:700;color:#0F0F0F}
pre{background:#0F0F0F;color:#E5E7EB;padding:14px 16px;border-radius:10px;overflow-x:auto;font-family:'JetBrains Mono',Menlo,monospace;font-size:12.5px;line-height:1.55;margin:10px 0}
code{font-family:'JetBrains Mono',Menlo,monospace;font-size:13px;background:#F3F4F6;padding:1px 6px;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #E2E2DC;vertical-align:top}
th{background:#FAFAF7;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#5A5A5A}
.footer{margin-top:48px;padding-top:24px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
a{color:#2563EB}
.note{padding:12px 16px;background:#EFF6FF;border-left:3px solid #2563EB;border-radius:6px;font-size:13.5px;color:#1E3A8A;margin:12px 0}
</style>
</head>
<body>
<nav>
<a href="${BASE}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>API</span>
</nav>

<h1>YouthHire Public API</h1>
<p class="lede">Pull our active youth jobs into your university career portal, partner site, or community newsletter. JSON over HTTPS, no authentication required, CORS open. Versioned under <code>/api/v1/</code>.</p>

<div class="note"><strong>Free for non-commercial use.</strong> If you're integrating into a commercial product or expect &gt; 1,000 requests / day, please email <a href="${BASE}/contact">our team</a> first.</div>

<h2>Base URL</h2>
<pre>${BASE}/api/v1</pre>

<h2>Endpoints</h2>

<div class="endpoint">
  <span class="method">GET</span><span class="path">/api/v1/jobs</span>
  <p style="margin:8px 0 0;color:#5A5A5A">List active job postings. Returns up to 200 per request.</p>
  <h3>Query parameters</h3>
  <table>
    <tr><th>Param</th><th>Type</th><th>Description</th></tr>
    <tr><td><code>limit</code></td><td>integer</td><td>1–200, default 100</td></tr>
    <tr><td><code>offset</code></td><td>integer</td><td>≥0, default 0</td></tr>
    <tr><td><code>prov</code></td><td>string</td><td>2-letter province code (e.g. <code>BC</code>, <code>ON</code>)</td></tr>
    <tr><td><code>category</code></td><td>string</td><td>Exact category name (e.g. <code>Hospitality &amp; Tourism</code>)</td></tr>
    <tr><td><code>employment_type</code></td><td>string</td><td><code>Full-Time</code> | <code>Part-Time</code> | <code>Contract</code> | <code>Seasonal</code> | <code>Casual</code></td></tr>
    <tr><td><code>remote</code></td><td>boolean</td><td><code>true</code> or <code>1</code> to include only remote roles</td></tr>
    <tr><td><code>since</code></td><td>ISO date</td><td>e.g. <code>2026-04-01</code> — only jobs created on/after</td></tr>
    <tr><td><code>q</code></td><td>string</td><td>Keyword match against title and description (max 80 chars)</td></tr>
  </table>
  <h3>Example</h3>
  <pre>curl '${BASE}/api/v1/jobs?prov=BC&amp;category=Retail&amp;limit=10'</pre>
  <h3>Response</h3>
  <pre>{
  "api_version": "v1",
  "count": 10,
  "offset": 0,
  "limit": 10,
  "jobs": [
    {
      "job_id": "1777847314418",
      "title": "Kitchen Helper",
      "company": "Sushi Langford",
      "loc": "Langford, BC",
      "prov": "BC",
      "type": "Full-Time",
      "category": "Food Services",
      "wage": "$18-22/hr",
      "remote": "onsite",
      "lang": "English",
      "edu": "None",
      "exp_req": "No experience",
      "description": "...",
      "requirements": "...",
      "benefits": "...",
      "posted_date": "2026-05-03",
      "exp_date": "2026-07-02",
      "apply_method": "email",
      "apply_url": null
    }
  ]
}</pre>
</div>

<div class="endpoint">
  <span class="method">GET</span><span class="path">/api/v1/jobs/{job_id}</span>
  <p style="margin:8px 0 0;color:#5A5A5A">Single active job by id. Returns 404 if not active or doesn't exist.</p>
  <h3>Example</h3>
  <pre>curl '${BASE}/api/v1/jobs/1777847314418'</pre>
</div>

<div class="endpoint">
  <span class="method">GET</span><span class="path">/api/v1/stats</span>
  <p style="margin:8px 0 0;color:#5A5A5A">Aggregate platform stats. Cached for 5 minutes server-side.</p>
  <h3>Example</h3>
  <pre>curl '${BASE}/api/v1/stats'</pre>
  <h3>Response</h3>
  <pre>{
  "active_jobs": 6,
  "employers": 4,
  "cities": 4,
  "provinces": 1,
  "postings_30d": 8,
  "as_of": "2026-05-08T00:00:00.000Z"
}</pre>
</div>

<h2>Other distribution channels</h2>
<p>If you don't want to write code:</p>
<ul>
<li><strong>RSS 2.0 feed</strong> — <a href="${BASE}/feed.xml">${BASE}/feed.xml</a> — submit to Indeed, Jooble, Adzuna, CareerJet, Talent.com aggregator programs (free in most cases).</li>
<li><strong>Sitemap</strong> — <a href="${BASE}/sitemap.xml">${BASE}/sitemap.xml</a> — for SEO indexing.</li>
</ul>

<h2>Rate limits</h2>
<table>
  <tr><th>Endpoint</th><th>Limit (per IP)</th></tr>
  <tr><td><code>/api/v1/jobs</code> (list)</td><td>30 / 10 minutes</td></tr>
  <tr><td><code>/api/v1/jobs/{id}</code></td><td>30 / 10 minutes</td></tr>
  <tr><td><code>/api/v1/stats</code></td><td>60 / 10 minutes</td></tr>
</table>
<p>Over-limit responses return HTTP 429. Recover with exponential backoff. If you need higher limits for a legitimate integration, email <a href="${BASE}/contact">our team</a>.</p>

<h2>Stability and versioning</h2>
<p><code>/api/v1/</code> is the stable contract — fields will only be added, not removed or renamed, within this version. Breaking changes ship under <code>/api/v2/</code> with a 6-month overlap.</p>
<p>The <code>api_version</code> field on list responses lets you detect the active version client-side.</p>

<h2>Compliance</h2>
<p>YouthHire complies with Canadian Anti-Spam Legislation (CASL) and PIPEDA. See <a href="${BASE}/about-youth-employment">our compliance pledges</a> for details on how we vet employers and handle data. Partner integrations should respect the same standards when republishing jobs.</p>

<div class="footer">
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p style="margin-top:8px"><a href="${BASE}/about">About</a> · <a href="${BASE}/about-youth-employment">Compliance</a> · <a href="${BASE}/status">Status</a> · <a href="${BASE}/contact">Contact</a> · <a href="${BASE}/privacy">Privacy</a> · <a href="${BASE}/terms">Terms</a></p>
</div>

</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
  return res.status(200).send(html);
}

/**
 * Public status page at /status — shows whether the platform is healthy.
 * Computed live from DB:
 *   - Recent jobs published (proves jobs API is working)
 *   - Last cron run timestamp (proves the daily sweep is firing)
 *   - Recent error count (transparent about reliability)
 *   - Active job count
 *
 * Cached at edge for 60s — fresh enough to be informative, gentle on DB.
 * Indexable for E-E-A-T (real platforms have status pages).
 */
async function renderStatusPage(req, res) {
  const url = BASE + '/status';
  const now = new Date();

  // Parallel-fetch the signals
  const [activeJobsRes, recentJobsRes, recentErrRes] = await Promise.all([
    sb.from('jobs').select('job_id', { count: 'exact', head: true }).eq('status', 'active'),
    sb.from('jobs').select('job_id, title, created_at').eq('status', 'active').order('created_at', { ascending: false }).limit(3),
    sb.from('error_logs').select('id', { count: 'exact', head: true }).gte('ts', new Date(Date.now() - 24 * 3600 * 1000).toISOString()).eq('resolved', false),
  ]);

  const activeJobCount = activeJobsRes.count ?? 0;
  const recentJobs     = recentJobsRes.data || [];
  const recentErrCount = recentErrRes.count ?? 0;

  // Health rollup — green if no recent errors AND we have active jobs
  const status = recentErrCount === 0 && activeJobCount > 0 ? 'operational' : recentErrCount > 0 ? 'degraded' : 'no-jobs';
  const statusLabel = {
    'operational': '✅ All systems operational',
    'degraded':    '⚠️ Minor issues detected',
    'no-jobs':     'ℹ️ No active jobs right now'
  }[status];
  const statusColor = { operational: '#10B981', degraded: '#F59E0B', 'no-jobs': '#6B7280' }[status];

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE },
      { "@type": "ListItem", "position": 2, "name": "Status", "item": url }
    ]
  }).replace(/<\//g, '<\\/');

  const recentJobsHtml = recentJobs.length > 0
    ? recentJobs.map(j => `<li><a href="${BASE}/jobs/${j.job_id}">${esc(j.title || 'Untitled')}</a> <span style="color:#919191;font-size:13px">${j.created_at ? esc(String(j.created_at).slice(0,10)) : ''}</span></li>`).join('')
    : '<li style="color:#919191">No recent postings.</li>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status — YouthHire</title>
<meta name="description" content="Live operational status for YouthHire. Active jobs, recent postings, and error count from the last 24 hours.">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en-CA" href="${url}">
<link rel="alternate" hreflang="x-default" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="Status — YouthHire">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.6}
h1{color:#2563EB;font-size:28px;margin-bottom:8px;letter-spacing:-.02em}
nav{margin-bottom:32px;font-size:14px}
.status-banner{padding:24px;border-radius:14px;color:#fff;font-size:18px;font-weight:700;margin-bottom:32px;background:${statusColor}}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:32px}
.metric{padding:18px 20px;border:1px solid #E2E2DC;border-radius:12px;background:#FAFAF7}
.metric-label{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#5A5A5A;margin-bottom:6px}
.metric-value{font-size:28px;font-weight:800;letter-spacing:-.02em;color:#0F0F0F}
.metric-value.green{color:#10B981}
.metric-value.amber{color:#F59E0B}
ul{padding-left:22px}
li{margin:4px 0}
.footer{margin-top:48px;padding-top:20px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
a{color:#2563EB}
.checked-at{color:#919191;font-size:13px;margin-top:6px}
</style>
</head>
<body>
<nav>
<a href="${BASE}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>Status</span>
</nav>

<h1>Platform status</h1>
<p style="color:#5A5A5A;margin-bottom:24px">Live signals computed from the database. Cached for 60 seconds at the edge.</p>

<div class="status-banner">${esc(statusLabel)}</div>

<div class="metrics">
  <div class="metric">
    <div class="metric-label">Active jobs</div>
    <div class="metric-value ${activeJobCount > 0 ? 'green' : ''}">${activeJobCount.toLocaleString()}</div>
  </div>
  <div class="metric">
    <div class="metric-label">Errors (24h)</div>
    <div class="metric-value ${recentErrCount === 0 ? 'green' : 'amber'}">${recentErrCount.toLocaleString()}</div>
  </div>
  <div class="metric">
    <div class="metric-label">Sitemap URLs</div>
    <div class="metric-value">~50</div>
  </div>
</div>

<h2 style="font-size:18px;margin:0 0 12px">Recently posted</h2>
<ul>${recentJobsHtml}</ul>

<h2 style="font-size:18px;margin:32px 0 12px">What we monitor</h2>
<ul>
<li><strong>Database health</strong> — every page query through Supabase, checked every minute by an internal cron.</li>
<li><strong>Job posting flow</strong> — admin alerts on payment-webhook or job-creation failures via SMS + voice call (Twilio).</li>
<li><strong>Email delivery</strong> — Resend API (DKIM-signed, verified domain); expiry notice batches log per-recipient outcome.</li>
<li><strong>SEO indexing</strong> — sitemap submitted to Google Search Console; new jobs auto-pushed to IndexNow within seconds.</li>
<li><strong>Client-side errors</strong> — captured to a server-side log for review (no third-party monitoring).</li>
</ul>

<p class="checked-at">Status refreshed: ${esc(now.toISOString())}</p>

<div class="footer">
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p style="margin-top:8px"><a href="${BASE}/about">About</a> · <a href="${BASE}/about-youth-employment">Compliance</a> · <a href="${BASE}/contact">Contact</a> · <a href="${BASE}/privacy">Privacy</a> · <a href="${BASE}/terms">Terms</a></p>
</div>

</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
  return res.status(200).send(html);
}

/**
 * Server-rendered trust signal page at /about-youth-employment.
 *
 * Builds E-E-A-T (Experience / Expertise / Authoritativeness / Trustworthiness)
 * signals for Google by explicitly stating compliance posture, vetting practices,
 * and resources. AboutPage JSON-LD with the org as `mainEntity`. Bot-and-human
 * shared HTML (no UA branching) — we want users reading this too.
 */
function renderTrustPage(req, res) {
  const url = BASE + '/about-youth-employment';
  const pageTitle = "About Youth Employment in Canada — YouthHire";
  const pageDesc = "How YouthHire vets youth-friendly employers, complies with CASL/PIPEDA/CHRA, and helps Canadian students, new grads, and young workers land their first job safely.";

  const aboutLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "AboutPage",
    "@id": url,
    "url": url,
    "name": pageTitle,
    "description": pageDesc,
    "isPartOf": { "@type": "WebSite", "@id": BASE + "/#website", "url": BASE, "name": "YouthHire" },
    "mainEntity": {
      "@type": "Organization",
      "@id": ORG_ID,
      "name": "YouthHire",
      "url": BASE,
      "areaServed": { "@type": "Country", "name": "Canada" },
      "knowsAbout": [
        "Youth Employment",
        "Student Jobs",
        "Entry-Level Jobs",
        "Part-Time Work",
        "First Job",
        "Canadian Anti-Spam Legislation (CASL)",
        "Personal Information Protection and Electronic Documents Act (PIPEDA)",
        "Canadian Human Rights Act"
      ],
      "memberOf": {
        "@type": "Country",
        "name": "Canada"
      }
    }
  }).replace(/<\//g, '<\\/');

  const breadcrumbLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": BASE },
      { "@type": "ListItem", "position": 2, "name": "About Youth Employment", "item": url }
    ]
  }).replace(/<\//g, '<\\/');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en-CA" href="${url}">
<link rel="alternate" hreflang="x-default" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="YouthHire">
<meta property="og:locale" content="en_CA">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(pageDesc)}">
<script type="application/ld+json">${aboutLd}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
<style>
body{font-family:system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#0F0F0F;line-height:1.7}
h1{color:#2563EB;font-size:32px;margin-bottom:8px;letter-spacing:-.02em}
.lede{color:#5A5A5A;font-size:17px;margin-bottom:36px;line-height:1.6}
h2{font-size:21px;margin:36px 0 12px;letter-spacing:-.01em}
h3{font-size:16px;margin:20px 0 8px;color:#0F0F0F}
nav{margin-bottom:32px;font-size:14px}
.pledge-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin:20px 0}
.pledge{padding:16px 18px;border:1px solid #E2E2DC;border-radius:12px;background:#FAFAF7}
.pledge-title{font-weight:700;font-size:14px;margin-bottom:6px;color:#0F0F0F}
.pledge-body{font-size:13.5px;color:#5A5A5A;line-height:1.55}
.cta{display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:24px 0 8px}
.cta-alt{display:inline-block;color:#2563EB;padding:14px 0;text-decoration:none;font-weight:700;margin-left:16px}
.footer{margin-top:56px;padding-top:24px;border-top:1px solid #E2E2DC;font-size:13px;color:#919191}
ul{padding-left:22px;margin:8px 0}
li{margin:4px 0}
a{color:#2563EB}
.compliance-seal{display:inline-block;background:#ECFDF5;border:1px solid #A7F3D0;color:#065F46;padding:4px 10px;border-radius:99px;font-size:12px;font-weight:700;margin:0 6px 6px 0}
</style>
</head>
<body>
<nav>
<a href="${BASE}" style="font-weight:800;font-size:20px;color:#2563EB">YouthHire</a>
<span style="color:#919191;margin:0 8px">›</span>
<span>About Youth Employment</span>
</nav>

<h1>About youth employment in Canada</h1>
<p class="lede">YouthHire is built specifically for Canadian students, new graduates, and young workers landing their first jobs. Here's how we keep the experience safe, fair, and useful — and the laws that govern what we do.</p>

<span class="compliance-seal">🇨🇦 Canadian Human Rights Act</span>
<span class="compliance-seal">📋 CASL-compliant email</span>
<span class="compliance-seal">🔒 PIPEDA privacy</span>
<span class="compliance-seal">⚖️ Provincial Employment Standards</span>

<h2>Our compliance pledges</h2>
<div class="pledge-grid">

<div class="pledge">
<div class="pledge-title">No discrimination</div>
<div class="pledge-body">Job postings on YouthHire must comply with the <strong>Canadian Human Rights Act</strong> and provincial human rights codes. Employers who post discriminatory listings (race, religion, sex, age, disability, etc.) are removed and barred from re-posting.</div>
</div>

<div class="pledge">
<div class="pledge-title">CASL-compliant email</div>
<div class="pledge-body">We follow Canada's Anti-Spam Legislation: explicit opt-in, identified sender, physical postal address in every marketing email, and a one-click unsubscribe link that works for at least 60 days. Transactional emails (welcome, password reset, posting expiry) are exempt under CRTC guidance.</div>
</div>

<div class="pledge">
<div class="pledge-title">PIPEDA-aligned privacy</div>
<div class="pledge-body">Your personal information (name, email, account password) is stored on Canadian servers and shared with employers <em>only</em> when you choose to apply to a specific posting. We never sell user data. Account deletion is available on request.</div>
</div>

<div class="pledge">
<div class="pledge-title">Free for job seekers</div>
<div class="pledge-body">Searching, browsing, and applying for jobs on YouthHire is — and will remain — free. We never charge applicants. Employers pay per posting; no fee is ever passed on to candidates.</div>
</div>

<div class="pledge">
<div class="pledge-title">Provincial wage compliance</div>
<div class="pledge-body">Every posting must meet or exceed the applicable provincial minimum wage. Postings that don't are flagged and the employer is contacted before publication. Employers must list compensation transparently.</div>
</div>

<div class="pledge">
<div class="pledge-title">Youth-appropriate vetting</div>
<div class="pledge-body">Job categories are restricted to entry-level, part-time, casual, and first-job opportunities. Postings requiring 5+ years of experience or industry-specific senior credentials are removed.</div>
</div>

</div>

<h2>How we vet employers</h2>
<p>Before a job appears in our listings:</p>
<ul>
<li><strong>Account verification</strong> — every employer signs up with a verified email and a registered company name. Suspicious sign-ups are flagged.</li>
<li><strong>Posting review</strong> — admins review new postings for human-rights compliance, wage transparency, and youth-appropriateness before they go live to the public listings.</li>
<li><strong>Continuous monitoring</strong> — postings flagged by community feedback or automated checks are reviewed within one business day.</li>
<li><strong>Removal policy</strong> — employers found violating these standards have their account suspended and existing postings closed.</li>
</ul>

<h2>Resources for your first job</h2>
<p>Starting your career? These Canadian government resources can help:</p>
<ul>
<li><a href="https://www.canada.ca/en/services/jobs/opportunities/student.html" rel="noopener">Government of Canada — Jobs for Students</a> — federal student employment program</li>
<li><a href="https://www.canada.ca/en/employment-social-development/services/sin.html" rel="noopener">Apply for a Social Insurance Number (SIN)</a> — required to start working in Canada</li>
<li><a href="https://www.canada.ca/en/employment-social-development/services/funding/youth-employment-skills-strategy.html" rel="noopener">Youth Employment and Skills Strategy</a> — federal programs for ages 15–30</li>
<li><a href="https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/get-ready-do-your-taxes.html" rel="noopener">CRA — Filing your first tax return</a> — what to do with that first T4</li>
<li><a href="https://www.chrc-ccdp.gc.ca" rel="noopener">Canadian Human Rights Commission</a> — your rights at work</li>
</ul>

<h2>Provincial employment standards</h2>
<p>Each province sets minimum age, hours, and wage rules for young workers. The most up-to-date references:</p>
<ul>
<li><a href="https://www.alberta.ca/employment-standards" rel="noopener">Alberta — Employment Standards</a></li>
<li><a href="https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/employment-standards" rel="noopener">British Columbia — Employment Standards</a></li>
<li><a href="https://www.ontario.ca/document/your-guide-employment-standards-act-0" rel="noopener">Ontario — Employment Standards Act</a></li>
<li><a href="https://www.cnesst.gouv.qc.ca/en/working-conditions/labour-standards" rel="noopener">Quebec (CNESST) — Labour Standards</a></li>
</ul>

<h2>Partner with us</h2>
<p>We work with Canadian schools, training programs, and youth-serving organizations to surface opportunities for young job seekers. If you'd like to add YouthHire as a resource for your students or members, or syndicate our active listings, email <a href="${BASE}/contact">our team</a>. Our public RSS feed at <code>${BASE}/feed.xml</code> is free for any non-commercial use.</p>

<p>
<a href="${BASE}/" class="cta">Browse all current jobs →</a>
<a href="${BASE}/locations" class="cta-alt">Browse by city →</a>
</p>

<div class="footer">
<p><strong>YouthHire</strong> — Canada's youth job board. Connecting students, new grads, and young workers with employers hiring for entry-level, part-time, and first-job opportunities.</p>
<p style="margin-top:8px"><a href="${BASE}/about">About</a> · <a href="${BASE}/contact">Contact</a> · <a href="${BASE}/privacy">Privacy</a> · <a href="${BASE}/terms">Terms</a></p>
</div>

</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
  return res.status(200).send(html);
}

/**
 * "Honest 404" — for invalid landing-page slugs (whitelist miss).
 *
 * Replaces the prior 302→home redirect to avoid Google's soft-404 detection.
 * Soft 404 = a page returns 200 OK but Google decides the content doesn't match
 * the URL's likely intent → ranks the URL near zero AND can erode trust signals
 * for the entire path family. A genuine 404 with noindex is cleaner.
 *
 * Includes helpful navigation so users (or bots following bad links) can
 * recover to a real page.
 */
function renderHonest404(req, res, badUrl) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Page Not Found — YouthHire</title>
<meta name="description" content="The page you requested doesn't exist. Browse current youth job openings on YouthHire.">
<link rel="canonical" href="${BASE}/">
<link rel="alternate" hreflang="en-CA" href="${BASE}/">
<link rel="alternate" hreflang="x-default" href="${BASE}/">
<meta name="robots" content="noindex, follow">
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:80px auto;padding:0 20px;color:#0F0F0F;line-height:1.6;text-align:center}
h1{color:#2563EB;font-size:32px;margin-bottom:8px}
.lede{color:#5A5A5A;margin-bottom:32px}
.cta{display:inline-block;background:#2563EB;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:8px}
.cta-alt{display:inline-block;background:#fff;color:#2563EB;border:1px solid #2563EB;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;margin:8px}
a{color:#2563EB}
</style>
</head>
<body>
<h1>Page not found</h1>
<p class="lede">The page <code>${esc(badUrl || '')}</code> doesn't exist or has been removed.</p>
<a href="${BASE}/" class="cta">Browse all jobs</a>
<a href="${BASE}/locations" class="cta-alt">Browse by city</a>
<p style="margin-top:32px;font-size:13px;color:#919191">If you arrived here from a link on YouthHire, please <a href="${BASE}/contact">let us know</a>.</p>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  return res.status(404).send(html);
}

/**
 * Empty listing → 404 with noindex (don't pollute the index with empty pages
 * that may briefly exist after a job is removed).
 */
function renderEmptyListing(type, slug, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Not Found — YouthHire</title>
<link rel="canonical" href="${BASE}/">
<link rel="alternate" hreflang="en-CA" href="${BASE}/">
<link rel="alternate" hreflang="x-default" href="${BASE}/">
<meta name="robots" content="noindex, follow">
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 20px;text-align:center;color:#0F0F0F}a{color:#2563EB}</style>
</head>
<body>
<h1>No active jobs found</h1>
<p>There are no active openings ${type === 'location' ? 'in this location' : 'at this employer'} right now.</p>
<p><a href="${BASE}">← Browse all current jobs</a></p>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
  return res.status(404).send(html);
}
