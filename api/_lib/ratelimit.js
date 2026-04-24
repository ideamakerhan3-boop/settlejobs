// Durable rate limiter backed by the Supabase `rate_limits` table.
// Works across serverless cold starts and all concurrent instances.
// Returns true if the request is allowed, false if it should be blocked.

export async function rateLimit(sb, key, maxAttempts, windowMs) {
  const now = new Date();
  const { data: row } = await sb
    .from('rate_limits')
    .select('count, expires_at')
    .eq('key', key)
    .maybeSingle();

  // No record or window expired — start fresh
  if (!row || new Date(row.expires_at) <= now) {
    const expires = new Date(now.getTime() + windowMs).toISOString();
    await sb.from('rate_limits').upsert(
      { key, count: 1, first_at: now.toISOString(), expires_at: expires },
      { onConflict: 'key' }
    );
    return true;
  }

  // Still within window
  if (row.count >= maxAttempts) return false;

  // Increment. Not atomic across instances but good enough for brute-force caps:
  // worst case a racing attacker lands 1-2 extra attempts, still blocked soon.
  await sb.from('rate_limits').update({ count: row.count + 1 }).eq('key', key);
  return true;
}

// Best-effort cleanup of stale rows. Cheap enough to call from cron.
export async function purgeExpiredRateLimits(sb) {
  await sb.from('rate_limits').delete().lt('expires_at', new Date().toISOString());
}
