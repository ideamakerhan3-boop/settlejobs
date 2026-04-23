// Shared password verification helper.
// Supports legacy unsalted SHA-256 (pre-bcrypt users) and bcrypt.
// On legacy match, transparently upgrades the stored hash to bcrypt.

import bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = 12;
const BCRYPT_PREFIX = '$2';

// sb: Supabase service_role client
// pw_hash: SHA-256 hex (64 chars) from client
// storedPw: accounts.pw (bcrypt hash OR legacy SHA-256)
// email: account email (for upgrade UPDATE)
export async function verifyAndUpgrade(sb, email, pw_hash, storedPw) {
  if (!storedPw || !pw_hash) return false;
  if (storedPw.startsWith(BCRYPT_PREFIX)) {
    return await bcrypt.compare(pw_hash, storedPw);
  }
  if (storedPw === pw_hash) {
    try {
      const upgraded = await bcrypt.hash(pw_hash, BCRYPT_ROUNDS);
      await sb.from('accounts').update({ pw: upgraded }).eq('email', email);
    } catch (e) {
      console.error('bcrypt upgrade failed for', email, e.message);
    }
    return true;
  }
  return false;
}
