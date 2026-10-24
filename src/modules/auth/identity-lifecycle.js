import { AuthenticationRequiredError } from './errors.js';

// The caller owns the transaction and writes its audit record before commit.
// Lock the identity before changing password/status and before calling this helper.
export async function invalidateIdentitySecurity(client, { userId, now = new Date(), keepSessionId = null }) {
  const user = (await client.query('SELECT id FROM usuarios WHERE id=$1 FOR UPDATE', [userId])).rows[0];
  if (!user) throw new AuthenticationRequiredError();
  const updated = (await client.query(`UPDATE usuarios SET security_version=security_version+1,updated_at=$2
    WHERE id=$1 RETURNING security_version`, [userId, now])).rows[0];
  await client.query(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$2)
    WHERE usuario_id=$1 AND ($3::uuid IS NULL OR id<>$3) AND revoked_at IS NULL`, [userId, now, keepSessionId]);
  if (keepSessionId) await client.query(`UPDATE auth_sessions SET security_version=$3
    WHERE usuario_id=$1 AND id=$2 AND revoked_at IS NULL`, [userId, keepSessionId, updated.security_version]);
  await client.query(`UPDATE identity_challenges SET consumed_at=COALESCE(consumed_at,$2),envelope=NULL
    WHERE usuario_id=$1 AND (consumed_at IS NULL OR envelope IS NOT NULL)`, [userId, now]);
  await client.query('UPDATE account_tokens SET consumed_at=$2 WHERE usuario_id=$1 AND consumed_at IS NULL', [userId, now]);
  await client.query(`UPDATE account_email_outbox SET envelope=NULL,status='expired',lease_id=NULL
    WHERE usuario_id=$1 AND token_id IS NOT NULL AND status IN ('pending','sending')`, [userId]);
  return { securityVersion: updated.security_version };
}
