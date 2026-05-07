// IndexNow: Notify search engines (Bing, Yandex, and Google via partnership)
// when a new job page is published or updated.
// No OAuth or service account needed — just a static key file hosted on the domain.
// Key file: https://www.canadayouthhire.ca/{INDEXNOW_KEY}.txt  (content = key)

const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'c7f2a9e4b1d3f8a5c2e7b4d9f1a6c3e8';
const BASE_URL = 'https://www.canadayouthhire.ca';

// Slugify + normalizeLoc — keep in sync with api/job-page.js, api/sitemap.js
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

// Mirror of PROVINCE_SLUGS / CATEGORY_SLUGS in api/job-page.js, inverted
// for code/name → slug lookups. Keep in sync.
const PROVINCE_CODE_TO_SLUG = {
  'AB': 'alberta', 'BC': 'british-columbia', 'MB': 'manitoba',
  'NB': 'new-brunswick', 'NL': 'newfoundland-and-labrador', 'NS': 'nova-scotia',
  'NT': 'northwest-territories', 'NU': 'nunavut', 'ON': 'ontario',
  'PE': 'prince-edward-island', 'QC': 'quebec', 'SK': 'saskatchewan', 'YT': 'yukon'
};
const CATEGORY_NAME_TO_SLUG = {
  'Hospitality & Tourism': 'hospitality-tourism',
  'Food Services': 'food-services',
  'Construction': 'construction',
  'Health Care': 'health-care',
  'Retail': 'retail',
  'Transportation & Logistics': 'transportation-logistics',
  'General Labour': 'general-labour',
  'Child Care': 'child-care',
  'Manufacturing': 'manufacturing',
  'Technology': 'technology',
  'Education': 'education',
  'Agriculture': 'agriculture'
};

async function submit(urls) {
  if (!urls || urls.length === 0) return;
  try {
    const resp = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: 'www.canadayouthhire.ca',
        key: INDEXNOW_KEY,
        keyLocation: `${BASE_URL}/${INDEXNOW_KEY}.txt`,
        urlList: urls
      })
    });
    console.log('[IndexNow] submitted', urls.length, 'URL(s) → status', resp.status);
  } catch (e) {
    // Non-critical: IndexNow failure should never block job creation
    console.warn('[IndexNow] ping failed (non-critical):', e.message);
  }
}

/**
 * Notify IndexNow of a new or updated job URL.
 * Fire-and-forget — never throws, never blocks job creation.
 * @param {string|number} jobId
 */
export async function notifyIndexNow(jobId) {
  if (!jobId) return;
  return submit([`${BASE_URL}/jobs/${jobId}`]);
}

/**
 * Richer notify — submits the job URL plus the affected location/employer
 * landing pages and the top-level browse indexes, so Google can re-crawl
 * the long-tail matrix when a posting changes. Falls back to job-only
 * submission if no metadata is provided.
 * Fire-and-forget — never throws.
 * @param {{job_id: string|number, loc?: string, prov?: string, company?: string}} job
 */
export async function notifyIndexNowJob(job) {
  if (!job || !job.job_id) return;
  const urls = [`${BASE_URL}/jobs/${job.job_id}`];

  if (job.loc) {
    const norm = normalizeLoc(job.loc, job.prov);
    const locSlug = slugify(norm + (job.prov ? '-' + job.prov : ''));
    if (locSlug) urls.push(`${BASE_URL}/locations/${locSlug}`);
  }
  if (job.company) {
    const empSlug = slugify(job.company);
    if (empSlug) urls.push(`${BASE_URL}/employers/${empSlug}`);
  }

  // Province landing — `prov` is a 2-letter code; map to full slug
  const provSlug = PROVINCE_CODE_TO_SLUG[String(job.prov || '').toUpperCase()];
  if (provSlug) urls.push(`${BASE_URL}/jobs-in-${provSlug}`);

  // Category landing — `category` is the DB-stored display name; map to slug
  const catSlug = CATEGORY_NAME_TO_SLUG[job.category];
  if (catSlug) urls.push(`${BASE_URL}/${catSlug}-jobs`);

  // Top-level browse indexes — count/membership changes when a job is added
  urls.push(`${BASE_URL}/locations`);
  urls.push(`${BASE_URL}/employers`);

  return submit(urls);
}
