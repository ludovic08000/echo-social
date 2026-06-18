import { supabase } from '@/integrations/supabase/client';
import { assessCurrentBrowserDevice, trustCurrentDeviceAfterPin } from '@/lib/security/browserDeviceTrust';

let currentUserId: string | null = null;
let assessing = false;
let promptVisible = false;

function showFallbackPrompt(message: string) {
  if (promptVisible || typeof document === 'undefined') return;
  promptVisible = true;

  const root = document.createElement('div');
  root.id = 'e2ee-device-trust-fallback';
  root.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:2147483647;display:flex;justify-content:center;pointer-events:none;';
  root.innerHTML = `
    <div style="max-width:420px;width:100%;pointer-events:auto;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:rgba(15,15,18,.96);color:white;box-shadow:0 20px 60px rgba(0,0,0,.35);padding:16px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
      <div style="font-weight:700;margin-bottom:6px;">Validation E2EE requise</div>
      <div style="font-size:13px;line-height:1.45;opacity:.82;margin-bottom:12px;">${message}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button data-close style="border:0;border-radius:10px;padding:8px 12px;background:rgba(255,255,255,.08);color:white;cursor:pointer;">Plus tard</button>
        <button data-open style="border:0;border-radius:10px;padding:8px 12px;background:white;color:#111;cursor:pointer;font-weight:600;">Ouvrir la messagerie</button>
      </div>
    </div>
  `;

  const close = () => {
    promptVisible = false;
    root.remove();
  };

  root.querySelector('[data-close]')?.addEventListener('click', close);
  root.querySelector('[data-open]')?.addEventListener('click', () => {
    close();
    window.location.href = '/messages';
  });

  document.body.appendChild(root);
}

async function assess(source: string) {
  if (!currentUserId || assessing) return;
  assessing = true;
  try {
    const assessment = await assessCurrentBrowserDevice(currentUserId);
    if (!assessment.trusted) {
      const detail = {
        userId: currentUserId,
        source,
        status: assessment.known ? 'PIN_REQUIRED_FOR_RISK_CHANGE' : 'PIN_REQUIRED_FOR_NEW_DEVICE',
        riskLevel: assessment.riskLevel,
        reasons: assessment.reasons,
        device: assessment.current,
        previous: assessment.previous ?? null,
        message: 'Nouveau navigateur ou changement de contexte détecté. Entrez votre PIN pour autoriser ce device.',
      };
      window.dispatchEvent(new CustomEvent('forsure:e2ee-device-trust-required', { detail }));
      window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
        detail: { userId: currentUserId, reason: detail.status, message: detail.message },
      }));
      showFallbackPrompt(detail.message);
    }
  } catch (error) {
    console.warn('[E2EE_DEVICE_TRUST_BOOT] assessment failed', error);
  } finally {
    assessing = false;
  }
}

async function trustAfterUnlock(source: string) {
  if (!currentUserId || assessing) return;
  assessing = true;
  try {
    await trustCurrentDeviceAfterPin({ userId: currentUserId });
    window.dispatchEvent(new CustomEvent('forsure:e2ee-device-trusted', { detail: { userId: currentUserId, source } }));
    window.dispatchEvent(new CustomEvent('forsure:e2ee-resync-complete', { detail: { userId: currentUserId, source } }));
  } catch (error) {
    console.warn('[E2EE_DEVICE_TRUST_BOOT] trust failed', error);
  } finally {
    assessing = false;
  }
}

if (typeof window !== 'undefined') {
  void supabase.auth.getUser().then(({ data }) => {
    currentUserId = data.user?.id ?? null;
    void assess('boot');
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    currentUserId = session?.user?.id ?? null;
    if (currentUserId) void assess('auth');
  });

  window.addEventListener('forsure-keys-unlocked', () => void trustAfterUnlock('keys-unlocked'));
  window.addEventListener('forsure-keys-restored', () => void trustAfterUnlock('keys-restored'));
  window.addEventListener('online', () => void assess('online'));
  window.addEventListener('focus', () => void assess('focus'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void assess('visibility');
  });
}
