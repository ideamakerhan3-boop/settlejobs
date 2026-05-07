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
 * Multi-mode SEO renderer (single endpoint to stay under Vercel Hobby 12-function cap).
 *
 *   GET /jobs/:id          → renderJobDetail (bots get HTML, humans 302→SPA)
 *   GET /locations/:slug   → renderListingPage('location') for both bots and humans
 *   GET /employers/:slug   → renderListingPage('employer') for both bots and humans
 *
 * Listing pages target long-tail SEO ("jobs in vancouver bc", "jobs at city of X")
 * and are real public pages, so we do NOT bot-redirect them.
 */
const BOT_RE = /bot|crawl|spider|slurp|Googlebot|Bingbot|DuckDuck|Yandex|Baidu|facebookexternalhit|Twitterbot|LinkedInBot/i;

export default async function handler(req, res) {
  const { id, type, slug } = req.query;

  if (type === 'location' && slug) {
    return renderListingPage('location', String(slug), req, res);
  }
  if (type === 'employer' && slug) {
    return renderListingPage('employer', String(slug), req, res);
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
    return res.redirect(302, BASE + '/');
  }

  // ISO 8601 dates required by Google for Jobs
  const posted  = toISO(job.posted_date) || toISO(job.created_at) || new Date().toISOString().split('T')[0];
  const expires = toISO(job.exp_date) || '';

  // Detect expired posting (exp_date in the past)
  const isExpired = expires && new Date(expires) < new Date();

  const url   = BASE + '/jobs/' + id;
  const title = esc(job.title) + ' at ' + esc(job.company) + ' — YouthHire';
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
        "addressLocality": job.loc  || '',
        "addressRegion":   job.prov || '',
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
<span>📍 ${esc(job.loc || 'Canada')}${job.prov ? ', ' + esc(job.prov) : ''}</span>
<span>💼 ${esc(job.type || 'Full-Time')}</span>
${job.wage ? '<span>💰 ' + esc(job.wage) + '</span>' : ''}
${job.category ? '<span>📂 ' + esc(job.category) + '</span>' : ''}
${job.remote && job.remote !== 'onsite' ? '<span>🏠 ' + esc(job.remote) + '</span>' : ''}
${job.lang && job.lang !== 'English' ? '<span>🌐 ' + esc(job.lang) + '</span>' : ''}
</div>
${(job.edu && job.edu !== 'None') || (job.exp_req && job.exp_req !== 'No experience') ? '<p style="font-size:13px;color:#5A5A5A;margin-bottom:8px">' + (job.edu && job.edu !== 'None' ? '🎓 ' + esc(job.edu) : '') + (job.exp_req && job.exp_req !== 'No experience' ? ' · 📋 ' + esc(job.exp_req) : '') + '</p>' : ''}
${posted ? '<p style="font-size:13px;color:#919191">Posted: ' + esc(posted) + (expires ? ' · Expires: ' + esc(expires) : '') + '</p>' : ''}

<div class="desc">${jobDescEscaped}${job.description && job.description.length > 500 ? '...' : ''}</div>
${job.requirements ? '<h3 style="margin:16px 0 8px;font-size:16px">Requirements</h3><ul>' + job.requirements.split('\\n').filter(Boolean).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' : ''}
${job.benefits ? '<h3 style="margin:16px 0 8px;font-size:16px">Benefits</h3><ul>' + job.benefits.split('\\n').filter(Boolean).map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>' : ''}

${job.apply_method === 'url' && safeApplyUrl ? '<p style="margin:16px 0"><strong>Apply:</strong> <a href="' + safeApplyUrl + '" style="color:#2563EB;font-weight:700">' + safeApplyUrl + '</a></p>' : ''}
${job.apply_method === 'email' && job.apply_email ? '<p style="margin:16px 0"><strong>Apply:</strong> <a href="mailto:' + esc(job.apply_email) + '" style="color:#2563EB;font-weight:700">' + esc(job.apply_email) + '</a></p>' : ''}
${!isExpired ? '<a href="' + BASE + '/#detail-' + id + '" class="cta">View Full Posting & Apply →</a>' : '<a href="' + BASE + '" class="cta">Browse Current Jobs →</a>'}

<div class="footer">
<p style="margin-bottom:12px"><strong>More opportunities</strong></p>
<p style="margin-bottom:12px">${job.loc ? '<a href="' + BASE + '/locations/' + slugify(job.loc + (job.prov ? '-' + job.prov : '')) + '">More jobs in ' + esc(job.loc) + (job.prov ? ', ' + esc(job.prov) : '') + '</a>' : ''}${job.loc && job.company ? ' · ' : ''}${job.company ? '<a href="' + BASE + '/employers/' + slugify(job.company) + '">More jobs at ' + esc(job.company) + '</a>' : ''}</p>
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
  if (!cleanSlug) return res.redirect(302, BASE + '/');

  const LIST_COLS = 'job_id, title, company, loc, prov, type, wage, category, remote, posted_date, created_at, exp_date, status';
  const { data: jobs } = await sb.from('jobs')
    .select(LIST_COLS)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (!jobs || jobs.length === 0) {
    return renderEmptyListing(type, cleanSlug, res);
  }

  // Filter to jobs whose slug matches the requested one
  const matched = jobs.filter(j => {
    if (type === 'location') {
      return slugify((j.loc || '') + (j.prov ? '-' + j.prov : '')) === cleanSlug;
    } else {
      return slugify(j.company || '') === cleanSlug;
    }
  });

  if (matched.length === 0) {
    return renderEmptyListing(type, cleanSlug, res);
  }

  // Derive display name from the first matched row (DB is source of truth)
  const sample = matched[0];
  const displayName = type === 'location'
    ? (sample.loc || '') + (sample.prov ? ', ' + sample.prov : '')
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
    const otherSlug = type === 'location' ? slugify(j.company || '') : slugify((j.loc || '') + (j.prov ? '-' + j.prov : ''));
    const otherLink = type === 'location'
      ? (j.company ? '<a href="' + BASE + '/employers/' + otherSlug + '">' + esc(j.company) + '</a>' : '')
      : (j.loc ? '<a href="' + BASE + '/locations/' + otherSlug + '">' + esc(j.loc) + (j.prov ? ', ' + esc(j.prov) : '') + '</a>' : '');
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
 * Empty listing → 404 with noindex (don't pollute the index with empty pages
 * that may briefly exist after a job is removed).
 */
function renderEmptyListing(type, slug, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Not Found — YouthHire</title>
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
