/**
 * Typed wrappers for Supabase RPC calls used by the E2EE / crypto layer.
 *
 * These RPCs may not yet exist in the auto-generated `Database` types
 * (`src/integrations/supabase/types.ts`). Rather than sprinkling `as any`
 * casts at every call site, we centralize the casting + typing here so the
 * rest of the codebase stays fully typed.
 *
 * If/when these RPCs are added to the generated types, the internal `as any`
 * casts can be removed without touching any caller.
 */

import { supabase } from '@/integrations/supabase/client';

// ---------- Shared helpers ----------

type RpcResult<T> = { data: T | null; error: Error | null };

async function callRpc<T>(fn: string, args?: object): Promise<RpcResult<T>> {
  const rpc = supabase.rpc as unknown as (
    name: string,
    parameters?: object,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc(fn, args);
  return { data: (data ?? null) as T | null, error: (error ?? null) as Error | null };
}

// ---------- Server crypto state ----------

export interface ServerCryptoStateRow {
  user_id: string;
  key_slot_id: string;
  identity_epoch: number;
  status: 'needs_client_key' | 'ready' | 'error';
  client_key_published_at: string | null;
  updated_at: string;
}

export function rpcEnsureUserCryptoState() {
  return callRpc<ServerCryptoStateRow>('ensure_user_crypto_state');
}

export interface MarkUserCryptoReadyArgs {
  p_fingerprint: string;
}

export function rpcMarkUserCryptoReady(args: MarkUserCryptoReadyArgs) {
  return callRpc<ServerCryptoStateRow>('mark_user_crypto_ready', args);
}

// ---------- Temporary device approval bridge ----------

export interface ApproveDeviceEnrollmentDecisionArgs {
  p_decision: 'approve' | 'reject';
  p_bootstrap_primary: boolean;
  p_approver_device_id: string;
  p_device_id: string;
  p_challenge_id: string;
  p_signature: string;
}

export interface ApproveDeviceEnrollmentDecisionResult {
  ok: boolean;
  code: string;
  device_id?: string;
  challenge_id?: string;
  device_role?: string | null;
  binding_status?: string | null;
}

export function rpcApproveDeviceEnrollmentDecision(args: ApproveDeviceEnrollmentDecisionArgs) {
  return callRpc<ApproveDeviceEnrollmentDecisionResult>('approve_device_enrollment_decision', args);
}

export interface BindDeviceAccountArgs {
  p_device_id: string;
  p_device_authorization_signature: string;
}

export interface BindDeviceAccountResult {
  ok: boolean;
  code: string;
  device_id?: string;
  existing?: boolean;
}

export function rpcBindDeviceAccount(args: BindDeviceAccountArgs) {
  return callRpc<BindDeviceAccountResult>('bind_device_account', args);
}
