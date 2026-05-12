#!/usr/bin/env node
// Production smoke test — verifies the critical surface area is healthy
// after a deploy. Used by .github/workflows/post-merge-smoke.yml on every
// push to main, and runnable locally any time.
//
// Usage: node scripts/smoke.mjs [base_url]
// Default base: https://www.canadayouthhire.ca
//
// Exits 0 on all-pass, 1 on any failure. Prints a per-check pass/fail line
// and a final summary.

const BASE = process.argv[2] || process.env.SMOKE_BASE || 'https://www.canadayouthhire.ca';
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name)  { passed++; console.log('  ✓', name); }
function fail(name, why) { failed++; failures.push({name, why}); console.log('  ✗', name, '—', why); }

async function check(name, fn) {
  try {
    const res = await fn();
    if (res === true || res === undefined) ok(name);
    else fail(name, String(res));
  } catch (e) {
    fail(name, e.message || String(e));
  }
}

async function fetchTxt(path, headers = {}) {
  const r = await fetch(BASE + path, { headers, redirect: 'manual' });
  const text = r.status >= 300 && r.status < 400 ? '' : await r.text();
  return { status: r.status, headers: r.headers, text };
}

async function main() {
  console.log('Smoke test against:', BASE);
  console.log('--------------------------------------------------------');

  console.log('\n[1] Static / SPA');
  await check('/ returns 200', async () => {
    const r = await fetchTxt('/');
    return r.status === 200 || `got ${r.status}`;
  });
  await check('/sitemap.xml has at least 30 <loc>', async () => {
    const r = await fetchTxt('/sitemap.xml');
    if (r.status !== 200) return `got ${r.status}`;
    const n = (r.text.match(/<loc>/g) || []).length;
    return n >= 30 || `only ${n} <loc> entries`;
  });
  await check('/robots.txt has sitemap line', async () => {
    const r = await fetchTxt('/robots.txt');
    return r.text.includes('Sitemap:') || 'no Sitemap line';
  });
  await check('/feed.xml is RSS 2.0', async () => {
    const r = await fetchTxt('/feed.xml');
    return r.text.includes('<rss version="2.0"') || 'not RSS 2.0';
  });

  console.log('\n[2] JobPosting flow (bot vs human split)');
  // Find a real active job id from the sitemap so we don't hardcode
  let activeId = null;
  try {
    const sm = await fetchTxt('/sitemap.xml');
    const m = sm.text.match(/\/jobs\/([0-9a-z_\-]+)</i);
    if (m) activeId = m[1];
  } catch (e) {}
  if (activeId) {
    await check(`/jobs/${activeId} (Googlebot) → 200 with JobPosting`, async () => {
      const r = await fetchTxt('/jobs/' + activeId, { 'User-Agent': UA_BOT });
      if (r.status !== 200) return `got ${r.status}`;
      return r.text.includes('"@type":"JobPosting"') || 'no JobPosting JSON-LD';
    });
    await check(`/jobs/${activeId} (human) → 302 redirect`, async () => {
      const r = await fetchTxt('/jobs/' + activeId);
      return r.status === 302 || `got ${r.status}`;
    });

    // Regression guards for PRs #65 / #66 / #70 / #72 — keep the wins locked in.
    await check(`/jobs/${activeId} <title> ≤ 60 chars (PR #70 truncation)`, async () => {
      const r = await fetchTxt('/jobs/' + activeId, { 'User-Agent': UA_BOT });
      const m = r.text.match(/<title>([^<]*)<\/title>/);
      if (!m) return 'no <title> tag';
      return m[1].length <= 60 || `title is ${m[1].length} chars: ${m[1]}`;
    });
    await check(`/jobs/${activeId} addressLocality has no province code (PR #65/#66)`, async () => {
      const r = await fetchTxt('/jobs/' + activeId, { 'User-Agent': UA_BOT });
      const m = r.text.match(/"addressLocality":"([^"]*)"/);
      if (!m) return 'no addressLocality in JSON-LD';
      // PR #65/#66 strips trailing ", BC" etc. — locality should be a city alone.
      return !/, [A-Z]{2}$/.test(m[1]) || `locality still has province: ${m[1]}`;
    });
    await check(`/jobs/${activeId} bot HTML has mobile @media (PR #72)`, async () => {
      const r = await fetchTxt('/jobs/' + activeId, { 'User-Agent': UA_BOT });
      return r.text.includes('@media (max-width:600px)') || 'no mobile media query';
    });
  } else {
    fail('JobPosting flow', 'no active job id in sitemap to test against');
  }

  console.log('\n[3] Landing page matrix');
  for (const url of ['/locations', '/employers', '/jobs-in-british-columbia', '/full-time-jobs', '/hospitality-tourism-jobs']) {
    await check(url + ' → 200', async () => {
      const r = await fetchTxt(url);
      return r.status === 200 || `got ${r.status}`;
    });
  }

  console.log('\n[4] Honest 404 (whitelist miss)');
  for (const url of ['/random-jobs', '/jobs-in-mars']) {
    await check(url + ' → 404', async () => {
      const r = await fetchTxt(url);
      return r.status === 404 || `got ${r.status}`;
    });
  }
  // /jobs/<bad-id> only honest-404s for BOT user agents — humans get 302→SPA
  // (handler bot-detects before DB lookup). Test the bot path.
  await check('/jobs/9999999999 (Googlebot) → 404', async () => {
    const r = await fetchTxt('/jobs/9999999999', { 'User-Agent': UA_BOT });
    return r.status === 404 || `got ${r.status}`;
  });

  console.log('\n[5] Public REST API v1');
  await check('/api/v1/stats → JSON with active_jobs', async () => {
    const r = await fetchTxt('/api/v1/stats');
    if (r.status !== 200) return `got ${r.status}`;
    const j = JSON.parse(r.text);
    return ('active_jobs' in j) || 'no active_jobs field';
  });
  await check('/api/v1/jobs?limit=1 → versioned envelope', async () => {
    const r = await fetchTxt('/api/v1/jobs?limit=1');
    if (r.status !== 200) return `got ${r.status}`;
    const j = JSON.parse(r.text);
    return (j.api_version === 'v1' && Array.isArray(j.jobs)) || 'envelope missing';
  });
  await check('/api/v1/jobs OPTIONS → CORS *', async () => {
    const r = await fetch(BASE + '/api/v1/jobs', { method: 'OPTIONS' });
    return r.headers.get('access-control-allow-origin') === '*' || 'CORS not *';
  });
  await check('/api docs page → APIReference JSON-LD', async () => {
    const r = await fetchTxt('/api');
    return r.text.includes('"@type":"APIReference"') || 'no APIReference JSON-LD';
  });

  console.log('\n[6] Trust + auth pages');
  await check('/about-youth-employment → 200 + AboutPage JSON-LD', async () => {
    const r = await fetchTxt('/about-youth-employment');
    return r.text.includes('"@type":"AboutPage"') || `status ${r.status}, no AboutPage`;
  });
  await check('/alerts → 200 (SPA)', async () => {
    const r = await fetchTxt('/alerts');
    return r.status === 200 || `got ${r.status}`;
  });
  await check('/status → 200 with status signal', async () => {
    const r = await fetchTxt('/status');
    if (r.status !== 200) return `got ${r.status}`;
    // Status page emits "All systems normal" / "Degraded" / "Issues" depending on signals
    return /All systems|operational|active jobs/i.test(r.text) || 'no status copy detected';
  });
  // (was: /saved → 200. Removed when the saved-jobs UI was reverted —
  // API stays for future seeker accounts but the SPA route is gone.)

  console.log('\n[7] Security posture');
  await check('Security headers present (HSTS + X-Frame-Options + CSP)', async () => {
    const r = await fetch(BASE + '/', { redirect: 'manual' });
    const missing = [];
    if (!r.headers.get('strict-transport-security')) missing.push('HSTS');
    if (!r.headers.get('x-frame-options')) missing.push('X-Frame-Options');
    if (!r.headers.get('content-security-policy')) missing.push('CSP');
    return missing.length === 0 || `missing: ${missing.join(', ')}`;
  });
  await check('/api/auth-api unauth login → 401/403', async () => {
    const r = await fetch(BASE + '/api/auth-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', email: 'nonexistent@example.invalid', pw_hash: 'a'.repeat(64) }),
    });
    return (r.status === 401 || r.status === 403) || `got ${r.status} (expected 401/403)`;
  });
  await check('/api/health-check unauth → 401', async () => {
    const r = await fetch(BASE + '/api/health-check');
    return r.status === 401 || `got ${r.status} (expected 401 without Bearer)`;
  });

  console.log('\n--------------------------------------------------------');
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ✗ ${f.name} — ${f.why}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
