import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const migration = source('supabase/migrations/20260930011500_login_security_step_up.sql');
const emailWorkerMigration = source('supabase/migrations/20260930120300_schedule_email_queue_worker.sql');
const edge = source('supabase/functions/login-security/index.ts');
const riskPolicy = source('supabase/functions/login-security/risk.ts');
const client = source('src/lib/security/loginSecurity.ts');
const auth = source('src/lib/auth.tsx');
const app = source('src/App.tsx');
const boundary = source('src/components/security/LoginSecurityBoundary.tsx');
const inbox = source('src/components/security/LoginApprovalInbox.tsx');
const emailDecisionBridge = source('src/components/security/LoginSecurityEmailDecisionBridge.tsx');

describe('risk-based login security architecture', () => {
  it('creates private session, challenge, token, and audit stores with staged enforcement', () => {
    expect(migration).toContain('create table if not exists public.login_security_sessions');
    expect(migration).toContain('create table if not exists public.login_security_challenges');
    expect(migration).toContain('create table if not exists public.login_security_email_tokens');
    expect(migration).toContain('create table if not exists public.login_security_events');
    expect(migration).toContain('enforcement_enabled boolean not null default false');
    expect(migration).toContain('revoke all on table public.login_security_email_tokens');
    expect(migration).not.toContain('grant select on table public.login_security_sessions to authenticated');
    expect(migration).not.toContain('grant select on table public.login_security_events to authenticated');
  });

  it('binds Aegis identity and device activation to the exact approved auth session', () => {
    expect(migration).toContain("auth.jwt() ->> 'session_id'");
    expect(migration).toContain('public.is_current_login_session_approved()');
    expect(migration).toContain('perform public.assert_current_login_session_approved()');
    expect(migration).toContain('aegis_guard_device_activation_by_login_session');
    expect(migration).toContain("new.approval_status = 'approved'");
    expect(migration).toContain("new.routing_status = 'ready'");
  });

  it('stores only hashed network identifiers and one-time email tokens', () => {
    expect(edge).toContain('hmacSha256(serviceRoleKey, context.ip)');
    expect(edge).toContain('const tokenHash = await sha256(token)');
    expect(edge).toContain(".eq('token_hash', tokenHash)");
    expect(edge).toContain(".is('consumed_at', null)");
    expect(edge).not.toContain('ip_address: context.ip');
    expect(edge).not.toContain("req.headers.get('x-country-code')");
    expect(edge).not.toContain("req.headers.get('x-vercel-ip-country')");
    expect(migration).not.toContain('ip_address inet');
  });

  it('requires a live approved Aegis device and an Ed25519 challenge proof', () => {
    expect(edge).toContain(".from('user_devices')");
    expect(edge).toContain(".eq('approval_status', 'approved')");
    expect(edge).toContain(".is('revoked_at', null)");
    expect(edge).toContain('verifyEd25519(device.device_signing_key, signature, challenge.payload)');
    expect(client).toContain("hardCrypto.sign(\n    'Ed25519'");
    expect(client).toContain("action: 'challenge'");
  });

  it('blocks key restoration and the crypto runtime until login approval', () => {
    const assessment = auth.indexOf('const security = await ensureLoginSecurity(data.session)');
    const setup = auth.indexOf('await completePendingPasswordSetup(data.user.id)', assessment);
    expect(assessment).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(assessment);
    expect(app).toContain("loginSecurity.status !== 'approved' || cryptoRestoring");
    expect(app).toContain('<LoginSecurityBoundary>');
    expect(boundary).toContain("loginSecurity.status === 'approved'");
  });

  it('revalidates approved token refreshes without reopening the full-screen connection check', () => {
    expect(auth).toContain("approvedServicesTokenRef.current === token && alreadyApproved");
    expect(auth).toContain('if (!alreadyApproved)');
    expect(auth).toContain("updateLoginSecurity({ status: 'checking', session: currentSecurity.session })");
    expect(auth).toContain("updateLoginSecurity({ status: 'checking', session: null })");
    expect(boundary).not.toContain('Vérification de la connexion');
    expect(boundary).not.toContain('Ouverture de ForSure');
    expect(boundary).not.toContain('Restauration sécurisée du compte');
    expect(boundary).toContain("loginSecurity.status === 'checking'");
  });

  it('supports both single-use email decisions and a trusted-device inbox', () => {
    expect(edge).toContain("subject: 'Confirmez votre nouvelle connexion ForSure'");
    expect(edge).toContain("purpose: 'transactional'");
    expect(edge).not.toContain("purpose: 'authentication'");
    expect(edge).toContain(".from('email_unsubscribe_tokens')");
    expect(edge).toContain('unsubscribe_token: unsubscribeToken');
    expect(edge).toContain('if (mutation.revokeAuthSession)');
    expect(riskPolicy).toContain('revokeAuthSession: true');
    expect(edge).toContain("approved_via: status === 'approved' ? 'trusted_device' : null");
    expect(edge).toContain("action === 'decide_pending'");
    expect(inbox).toContain('decidePendingLoginSecuritySession');
    expect(inbox).toContain("void decide('deny')");
    expect(inbox).toContain("void decide('approve')");
  });

  it('dispatches queued approval e-mails through a private Vault-authenticated worker', () => {
    expect(emailWorkerMigration).toContain("pgmq.metrics('auth_emails')");
    expect(emailWorkerMigration).toContain("pgmq.metrics('transactional_emails')");
    expect(emailWorkerMigration).toContain("secret.name = 'email_queue_service_role_key'");
    expect(emailWorkerMigration).toContain('/functions/v1/process-email-queue');
    expect(emailWorkerMigration).toContain("'Authorization', 'Bearer ' || v_service_secret");
    expect(emailWorkerMigration).toContain("'apikey', v_service_secret");
    expect(emailWorkerMigration).toMatch(/'process-email-queue',\r?\n\s+'5 seconds'/);
    expect(emailWorkerMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.process_email_queue_cron_tick\(\)\r?\nFROM PUBLIC, anon, authenticated/,
    );
    expect(emailWorkerMigration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.process_email_queue_cron_tick\(\)\r?\nTO authenticated/,
    );
  });

  it('keeps email link previews read-only while a browser click submits one direct decision', () => {
    expect(edge).toContain('?token=${encodeURIComponent(token)}&decision=approve');
    expect(edge).toContain('?token=${encodeURIComponent(token)}&decision=deny');
    expect(edge).toContain('loginSecurityToken: token');
    expect(edge).toContain('loginSecurityDecision: decision');
    expect(edge).toContain("new URL('/feed', `${SITE_URL}/`)");
    expect(emailDecisionBridge).toContain('window.location.hash.slice(1)');
    expect(emailDecisionBridge).toContain('window.history.replaceState');
    expect(emailDecisionBridge).toContain('formRef.current?.submit()');
    expect(emailDecisionBridge).toContain('method="post"');
    expect(emailDecisionBridge).toContain('name="action" value="email_decision"');
    expect(edge).toContain("contentType.includes('application/x-www-form-urlencoded')");
    const getBranch = edge.indexOf("if (req.method === 'GET')");
    const formBranch = edge.indexOf("contentType.includes('application/x-www-form-urlencoded')");
    const getBody = edge.slice(getBranch, formBranch);
    const decide = edge.indexOf('const completed = await decide(', formBranch);
    const consume = edge.indexOf(".update({ consumed_at: now, consumed_decision: decision })", formBranch);
    expect(getBranch).toBeGreaterThan(-1);
    expect(formBranch).toBeGreaterThan(getBranch);
    expect(getBody).not.toContain(".from('login_security_email_tokens')");
    expect(decide).toBeGreaterThan(formBranch);
    expect(consume).toBeGreaterThan(decide);
  });

  it('bounds unauthenticated bodies and prevents duplicate approval e-mails', () => {
    expect(edge).toContain('readBoundedBody(req, 4_096)');
    expect(edge).toContain('readBoundedBody(req, 16_384)');
    expect(edge).toContain("existing?.status === 'pending'");
    expect(edge).toContain('existing.email_sent_at');
    expect(edge).toContain(".update({ expires_at: expiresAt, updated_at: now.toISOString() })");
    expect(edge).toContain(".eq('status', 'pending')");
    expect(edge).toContain("code: 'CHALLENGE_RATE_LIMITED'");
  });

  it('fails open only while the server rollout gate itself is disabled', () => {
    expect(client).toContain("rpc('is_current_login_session_approved'");
    expect(auth).toContain('if (await isLoginSecurityServerGateOpen())');
    expect(migration).toContain('if not coalesce(v_enabled, false) then');
    expect(migration).toContain("security_session.status = 'approved'");
  });

  it('requires the same approved login session for privileged identity reset', () => {
    const identityReset = source('supabase/functions/identity-reset/index.ts');
    expect(identityReset).toContain("rpc('is_current_login_session_approved')");
    expect(identityReset).toContain('LOGIN_SECURITY_APPROVAL_REQUIRED');
    expect(identityReset.indexOf("rpc('is_current_login_session_approved')"))
      .toBeLessThan(identityReset.indexOf("rpc('replace_unrecoverable_identity_v2'"));
  });

  it('also gates privileged rotation and rotation-recovery Edge Functions', () => {
    const rotation = source('supabase/functions/identity-rotation/index.ts');
    const recovery = source('supabase/functions/identity-rotation-recovery/index.ts');
    for (const privilegedEdge of [rotation, recovery]) {
      expect(privilegedEdge).toContain("rpc('is_current_login_session_approved')");
      expect(privilegedEdge).toContain('LOGIN_SECURITY_APPROVAL_REQUIRED');
    }
    expect(rotation.indexOf("rpc('is_current_login_session_approved')"))
      .toBeLessThan(rotation.indexOf("rpc('begin_identity_rotation_v1'"));
    expect(recovery.indexOf("rpc('is_current_login_session_approved')"))
      .toBeLessThan(recovery.indexOf("rpc('finalize_identity_rotation_recovery_v1'"));
  });
});
