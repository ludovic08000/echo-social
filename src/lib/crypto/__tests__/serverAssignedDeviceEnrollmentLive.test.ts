// @ts-nocheck
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { supabase } from '@/integrations/supabase/client';
import { prepareDeviceAuthorization } from '../deviceIdentity';
import { fetchVerifiedDeviceIdentity } from '../signedDeviceList';
import {
  generateAndUploadDeviceSignedPrekey,
  refillDeviceOneTimePrekeysIfNeeded,
} from '../x3dh';

const LIVE = process.env.AEGIS_LIVE_SERVER_DEVICE_ENROLLMENT === '1';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const publishableKey = String(process.env.SUPABASE_ANON_KEY || '');
const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

interface LiveUser {
  id: string;
  token: string;
  refreshToken: string;
}

interface RpcResult {
  ok?: boolean;
  code?: string;
  challenge_id?: string;
  device_id?: string;
  nonce?: string;
  expires_at?: string;
  routing_status?: string;
}

const hashRef = (value: unknown) =>
  createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

function safeLog(
  runId: string,
  startedAt: number,
  stage: string,
  fields: Record<string, unknown> = {},
) {
  console.log(`AEGIS_SERVER_DEVICE_ENROLLMENT ${JSON.stringify({
    timestamp: new Date().toISOString(),
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    stage,
    ...fields,
  })}`);
}

async function anonymousSignup(runId: string, startedAt: number): Promise<LiveUser> {
  const requestId = randomUUID();
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${publishableKey}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify({
      data: {
        name: 'Aegis server DeviceID live probe',
        aegis_server_device_enrollment_run: runId,
      },
    }),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token || !payload?.refresh_token || !payload?.user?.id) {
    throw new Error(`ANONYMOUS_SIGNUP_FAILED:${response.status}:${payload?.message || 'unknown'}`);
  }
  safeLog(runId, startedAt, 'anonymous_user_created', {
    request_id: requestId,
    status: response.status,
    user_ref: hashRef(payload.user.id),
    is_anonymous: payload.user.is_anonymous === true,
  });
  return {
    id: payload.user.id,
    token: payload.access_token,
    refreshToken: payload.refresh_token,
  };
}

async function setActiveUser(user: LiveUser): Promise<void> {
  const { data, error } = await supabase.auth.setSession({
    access_token: user.token,
    refresh_token: user.refreshToken,
  });
  if (error || data.session?.user.id !== user.id) {
    throw new Error(`SET_ACTIVE_USER_FAILED:${error?.message || 'session mismatch'}`);
  }
}

async function directRpc(
  runId: string,
  startedAt: number,
  user: LiveUser,
  name: string,
  args: Record<string, unknown>,
  stage: string,
): Promise<RpcResult | number> {
  const requestId = randomUUID();
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${user.token}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify(args),
    redirect: 'error',
  });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  safeLog(runId, startedAt, stage, {
    rpc: name,
    request_id: requestId,
    status: response.status,
    http_ok: response.ok,
    rpc_ok: typeof payload === 'object' && payload !== null ? payload.ok ?? null : null,
    code: typeof payload === 'object' && payload !== null ? payload.code ?? null : null,
  });
  if (!response.ok) {
    throw new Error(`${stage.toUpperCase()}_HTTP_FAILED:${response.status}:${payload?.message || 'unknown'}`);
  }
  return payload;
}

function completionArgs(challenge: RpcResult, authorization: Awaited<ReturnType<typeof prepareDeviceAuthorization>>) {
  return {
    p_challenge_id: challenge.challenge_id,
    p_nonce: challenge.nonce,
    p_device_public_key: authorization.deviceKx.publicB64,
    p_device_signing_key: authorization.deviceSigning.publicB64,
    p_device_authorization_signature: authorization.authorizationSignature,
    p_account_identity_key: authorization.account.identityKey,
    p_account_signing_key: authorization.account.signingKey,
    p_account_fingerprint: authorization.account.fingerprint,
    p_account_binding_signature: authorization.account.bindingSignature,
  };
}

(LIVE ? describe : describe.skip)('Aegis live server-assigned DeviceID enrollment', () => {
  it('allocates, authorizes, repairs and settles iOS logical devices', async () => {
    if (!supabaseUrl || !publishableKey) throw new Error('LIVE_CONFIGURATION_MISSING');

    const runId = randomUUID();
    const startedAt = Date.now();
    safeLog(runId, startedAt, 'scenario_started', {
      platform: 'ios',
      flow: 'server_assigned_device_id_two_phase',
    });

    const user = await anonymousSignup(runId, startedAt);
    await setActiveUser(user);

    const challenge = await directRpc(
      runId,
      startedAt,
      user,
      'begin_user_device_enrollment',
      {
        p_device_name: 'Chrome iOS live enrollment probe',
        p_device_fingerprint: `live-ios-${hashRef(runId)}`,
        p_platform: 'ios',
        p_user_agent: 'aegis-live-server-device-enrollment/1',
      },
      'challenge_created',
    ) as RpcResult;

    expect(challenge.ok).toBe(true);
    expect(challenge.code).toBe('DEVICE_ENROLLMENT_CHALLENGE_CREATED');
    expect(challenge.device_id).toMatch(SERVER_DEVICE_ID_RE);
    expect(challenge.nonce?.length).toBeGreaterThanOrEqual(32);
    expect(Date.parse(challenge.expires_at || '')).toBeGreaterThan(Date.now());
    safeLog(runId, startedAt, 'server_device_id_allocated', {
      device_ref: hashRef(challenge.device_id),
      challenge_ref: hashRef(challenge.challenge_id),
      server_id_format_valid: true,
    });

    const authorization = await prepareDeviceAuthorization(user.id, challenge.device_id!);
    const args = completionArgs(challenge, authorization);
    const completed = await directRpc(
      runId,
      startedAt,
      user,
      'complete_user_device_enrollment',
      args,
      'enrollment_completed',
    ) as RpcResult;

    expect(completed.ok).toBe(true);
    expect(completed.code).toBe('DEVICE_ENROLLMENT_COMPLETED');
    expect(completed.device_id).toBe(challenge.device_id);
    expect(completed.routing_status).toBe('repairing');

    const idempotentCompletion = await directRpc(
      runId,
      startedAt,
      user,
      'complete_user_device_enrollment',
      args,
      'completion_recovered_idempotently',
    ) as RpcResult;
    expect(idempotentCompletion.ok).toBe(true);
    expect(idempotentCompletion.code).toBe('DEVICE_ENROLLMENT_ALREADY_COMPLETED');
    expect(idempotentCompletion.device_id).toBe(challenge.device_id);

    const cancelAfterCommit = await directRpc(
      runId,
      startedAt,
      user,
      'cancel_user_device_enrollment',
      {
        p_challenge_id: challenge.challenge_id,
        p_nonce: challenge.nonce,
        p_reason: 'lost_response_probe',
      },
      'cancel_after_commit_recovered',
    ) as RpcResult;
    expect(cancelAfterCommit.ok).toBe(true);
    expect(cancelAfterCommit.code).toBe('DEVICE_ENROLLMENT_ALREADY_COMPLETED');

    const verified = await fetchVerifiedDeviceIdentity(user.id, challenge.device_id!);
    expect(verified).toBeTruthy();
    expect(verified!.devicePublicKey).toBe(authorization.deviceKx.publicB64);
    expect(verified!.deviceSigningKey).toBe(authorization.deviceSigning.publicB64);
    safeLog(runId, startedAt, 'identity_directory_verified', {
      device_ref: hashRef(challenge.device_id),
      account_binding_valid: true,
      device_authorization_valid: true,
    });

    const publishedSpk = await generateAndUploadDeviceSignedPrekey(
      user.id,
      challenge.device_id!,
      authorization.deviceSigning.privateKey,
    );
    await refillDeviceOneTimePrekeysIfNeeded(user.id, challenge.device_id!);
    const opkCount = Number(await directRpc(
      runId,
      startedAt,
      user,
      'count_device_one_time_prekeys',
      { p_user_id: user.id, p_device_id: challenge.device_id },
      'prekeys_counted',
    ));
    expect(opkCount).toBe(100);

    const routeReady = await directRpc(
      runId,
      startedAt,
      user,
      'mark_current_device_route_ready',
      { p_device_id: challenge.device_id },
      'route_marked_ready',
    ) as RpcResult;
    expect(routeReady.ok).toBe(true);

    const { data: route, error: routeError } = await supabase
      .from('user_devices')
      .select('device_id,platform,is_active,approval_status,routing_status,routing_error,device_authorization_signature')
      .eq('user_id', user.id)
      .eq('device_id', challenge.device_id!)
      .single();
    if (routeError) throw new Error(`ROUTE_INSPECTION_FAILED:${routeError.message}`);
    expect(route.device_id).toBe(challenge.device_id);
    expect(route.platform).toBe('ios');
    expect(route.is_active).toBe(true);
    expect(route.approval_status).toBe('approved');
    expect(route.routing_status).toBe('ready');
    expect(route.routing_error).toBeNull();
    expect(typeof route.device_authorization_signature).toBe('string');
    expect(route.device_authorization_signature.length).toBeGreaterThan(40);
    safeLog(runId, startedAt, 'route_verified_ready', {
      device_ref: hashRef(challenge.device_id),
      platform: route.platform,
      approval_status: route.approval_status,
      routing_status: route.routing_status,
      active_spks: 1,
      available_opks: opkCount,
      spk_ref: hashRef(publishedSpk.spkId),
    });

    const cancelledChallenge = await directRpc(
      runId,
      startedAt,
      user,
      'begin_user_device_enrollment',
      {
        p_device_name: 'Cancelled iOS enrollment probe',
        p_device_fingerprint: `cancel-ios-${hashRef(runId)}`,
        p_platform: 'ios',
        p_user_agent: 'aegis-live-server-device-enrollment/1',
      },
      'cancellation_challenge_created',
    ) as RpcResult;
    expect(cancelledChallenge.ok).toBe(true);
    expect(cancelledChallenge.device_id).toMatch(SERVER_DEVICE_ID_RE);
    expect(cancelledChallenge.device_id).not.toBe(challenge.device_id);

    const invalidNonce = await directRpc(
      runId,
      startedAt,
      user,
      'cancel_user_device_enrollment',
      {
        p_challenge_id: cancelledChallenge.challenge_id,
        p_nonce: 'invalid-nonce-value-that-is-long-enough-000000000000',
        p_reason: 'invalid_nonce_probe',
      },
      'invalid_nonce_rejected',
    ) as RpcResult;
    expect(invalidNonce.ok).toBe(false);
    expect(invalidNonce.code).toBe('DEVICE_ENROLLMENT_INVALID_NONCE');

    const cancelled = await directRpc(
      runId,
      startedAt,
      user,
      'cancel_user_device_enrollment',
      {
        p_challenge_id: cancelledChallenge.challenge_id,
        p_nonce: cancelledChallenge.nonce,
        p_reason: 'live_probe_cleanup',
      },
      'challenge_cancelled',
    ) as RpcResult;
    expect(cancelled.ok).toBe(true);
    expect(cancelled.code).toBe('DEVICE_ENROLLMENT_CANCELLED');

    const cancelledAgain = await directRpc(
      runId,
      startedAt,
      user,
      'cancel_user_device_enrollment',
      {
        p_challenge_id: cancelledChallenge.challenge_id,
        p_nonce: cancelledChallenge.nonce,
        p_reason: 'live_probe_cleanup_retry',
      },
      'cancellation_recovered_idempotently',
    ) as RpcResult;
    expect(cancelledAgain.ok).toBe(true);
    expect(cancelledAgain.code).toBe('DEVICE_ENROLLMENT_ALREADY_CANCELLED');

    const { data: cancelledRoute, error: cancelledRouteError } = await supabase
      .from('user_devices')
      .select('device_id')
      .eq('user_id', user.id)
      .eq('device_id', cancelledChallenge.device_id!)
      .maybeSingle();
    if (cancelledRouteError) throw new Error(`CANCELLED_ROUTE_INSPECTION_FAILED:${cancelledRouteError.message}`);
    expect(cancelledRoute).toBeNull();

    safeLog(runId, startedAt, 'scenario_complete', {
      ok: true,
      users: 1,
      completed_devices: 1,
      cancelled_devices: 1,
      server_device_id_valid: true,
      account_binding_valid: true,
      device_authorization_valid: true,
      completion_idempotent: true,
      cancel_after_commit_safe: true,
      invalid_nonce_rejected: true,
      cancellation_idempotent: true,
      route_ready: true,
      published_spks: 1,
      published_opks: opkCount,
      duration_ms: Date.now() - startedAt,
    });

    await supabase.auth.signOut();
  }, 180_000);
});
