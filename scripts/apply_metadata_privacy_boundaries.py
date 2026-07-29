from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding='utf-8-sig')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    target.write_text(source.replace(old, new, 1), encoding='utf-8')


# Defensive redaction at the logging boundary. Callers may accidentally attach
# arbitrary metadata; the central logger is responsible for making server logs
# incapable of carrying keys, ciphertext or message text.
replace_once(
    'src/lib/crypto/errorLogger.ts',
    "const FLUSH_INTERVAL_MS = 2_000;\n",
    r'''const FLUSH_INTERVAL_MS = 2_000;
const MAX_METADATA_DEPTH = 4;
const SENSITIVE_FIELD_RE = /(?:plain(?:text)?|messagebody|contentkey|keycapsule|encrypted[_-]?body|cipher(?:text)?|secret|token|authorization|password|pin|recoverykey|privatekey)/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const LONG_BASE64_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;
const MEDIA_KEY_RE = /\x00MKEY:[^\s]+/g;

export function redactCryptoDiagnostic(value: string): string {
  return value
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(MEDIA_KEY_RE, '\x00MKEY:[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("?(?:plaintext|messageBody|contentKey|keyCapsule|encrypted_body|ciphertext|privateKey|recoveryKey|password|pin)"?\s*[:=]\s*)"?[^",}\s]+"?/gi, '$1[REDACTED]')
    .replace(LONG_BASE64_RE, '[REDACTED_B64]')
    .slice(0, 1000);
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_METADATA_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') return redactCryptoDiagnostic(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => sanitizeMetadataValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      result[key] = SENSITIVE_FIELD_RE.test(key)
        ? '[REDACTED]'
        : sanitizeMetadataValue(entry, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 200);
}
''',
    'error logger redaction helpers',
)
replace_once(
    'src/lib/crypto/errorLogger.ts',
    "    return { code, message: msg.slice(0, 1000), stack: err.stack?.slice(0, 2000) };\n",
    "    return {\n      code,\n      message: redactCryptoDiagnostic(msg),\n      stack: err.stack ? redactCryptoDiagnostic(err.stack).slice(0, 2000) : undefined,\n    };\n",
    'error classification redaction',
)
replace_once(
    'src/lib/crypto/errorLogger.ts',
    "    const enriched = { ...entry, ts: new Date().toISOString() };\n",
    r'''    const sanitizedEntry: CryptoErrorEntry = {
      ...entry,
      errorMessage: redactCryptoDiagnostic(entry.errorMessage),
      stack: entry.stack ? redactCryptoDiagnostic(entry.stack).slice(0, 2000) : entry.stack,
      metadata: sanitizeMetadataValue(entry.metadata) as Record<string, unknown> | null,
    };
    const enriched = { ...sanitizedEntry, ts: new Date().toISOString() };
''',
    'error entry redaction',
)
replace_once(
    'src/lib/crypto/errorLogger.ts',
    "        `[CRYPTO ${entry.severity.toUpperCase()}][${entry.context}] ${entry.errorCode}: ${entry.errorMessage}`,\n",
    "        `[CRYPTO ${sanitizedEntry.severity.toUpperCase()}][${sanitizedEntry.context}] ${sanitizedEntry.errorCode}: ${sanitizedEntry.errorMessage}`,\n",
    'error console redaction message',
)
replace_once(
    'src/lib/crypto/errorLogger.ts',
    "          conv: entry.conversationId,\n          myDev: entry.myDeviceId,\n          peer: entry.peerUserId,\n          peerDev: entry.peerDeviceId,\n          meta: entry.metadata,\n",
    "          conv: sanitizedEntry.conversationId,\n          myDev: sanitizedEntry.myDeviceId,\n          peer: sanitizedEntry.peerUserId,\n          peerDev: sanitizedEntry.peerDeviceId,\n          meta: sanitizedEntry.metadata,\n",
    'error console redaction metadata',
)

# The moderation edge may operate only on a server-readable system message owned
# by the authenticated sender. Standard Aegis rows are skipped without sending
# ciphertext or plaintext to any AI provider.
replace_once(
    'supabase/functions/message-moderation/index.ts',
    r'''      const { messageBody, messageId } = body;

      if (!messageBody || typeof messageBody !== "string") {
        return new Response(JSON.stringify({ error: "messageBody required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Skip moderation for system/special messages
''',
    r'''      const { messageBody, messageId } = body;

      if (!messageId || !messageBody || typeof messageBody !== "string") {
        return new Response(JSON.stringify({ error: "messageId and messageBody required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: authoritativeMessage, error: messageError } = await supabase
        .from("messages")
        .select("id, sender_id, conversation_id, body, body_kind")
        .eq("id", messageId)
        .maybeSingle();
      if (messageError) throw messageError;
      if (!authoritativeMessage || authoritativeMessage.sender_id !== user.id) {
        return new Response(JSON.stringify({ error: "FORBIDDEN_MESSAGE" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const bodyKind = authoritativeMessage.body_kind || "";
      const storedBody = authoritativeMessage.body || "";
      const isAegisCiphertext = bodyKind === "multi_device" || (
        storedBody.startsWith("{") &&
        storedBody.includes('"protocol":"forsure-aegis-message"')
      );
      if (isAegisCiphertext) {
        return new Response(JSON.stringify({
          safe: true,
          reason: null,
          skipped: "e2ee_client_private",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (bodyKind !== "system" || storedBody !== messageBody) {
        return new Response(JSON.stringify({ error: "UNVERIFIED_MESSAGE_CONTENT" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Skip moderation for system/special messages
''',
    'moderation authoritative message boundary',
)

# Web Push transport is encrypted to the browser, but push providers still see
# metadata. Message-related pushes therefore carry no user-authored preview.
replace_once(
    'supabase/functions/push-notify/index.ts',
    r'''    const payload = JSON.stringify({
      title, body: msgBody || "", icon: icon || "/pwa-192x192.png",
      badge: "/pwa-192x192.png", url: url || "/notifications",
      tag, kind, requireInteraction: !!requireInteraction,
      timestamp: Date.now(),
    });
''',
    r'''    const isPrivateMessagePush = typeof kind === "string" && (
      kind === "message" ||
      kind === "new_message" ||
      kind === "chat_message" ||
      kind.startsWith("message_")
    );
    const safeTitle = isPrivateMessagePush ? "Nouveau message" : title;
    const safeBody = isPrivateMessagePush ? "Ouvre ForSure pour le déchiffrer." : (msgBody || "");
    const payload = JSON.stringify({
      title: safeTitle, body: safeBody, icon: icon || "/pwa-192x192.png",
      badge: "/pwa-192x192.png", url: url || "/notifications",
      tag, kind, requireInteraction: !!requireInteraction,
      timestamp: Date.now(),
    });
''',
    'generic private message push',
)

# Tests for central redaction and source-level privacy boundaries.
Path('src/lib/crypto/__tests__/diagnosticRedaction.test.ts').write_text(r'''import { describe, expect, it } from 'vitest';
import { redactCryptoDiagnostic } from '@/lib/crypto/errorLogger';

describe('crypto diagnostic redaction', () => {
  it('removes keys, ciphertext, media keys and bearer-like tokens', () => {
    const value = [
      'contentKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'ciphertext: BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      '\x00MKEY:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue123456',
    ].join(' ');
    const redacted = redactCryptoDiagnostic(value);
    expect(redacted).toContain('[REDACTED');
    expect(redacted).not.toContain('AAAAAAAAAAAAAAAA');
    expect(redacted).not.toContain('BBBBBBBBBBBBBBBB');
    expect(redacted).not.toContain('CCCCCCCCCCCCCCCC');
    expect(redacted).not.toContain('eyJhbGci');
  });
});
''', encoding='utf-8')

Path('src/lib/crypto/__tests__/serverPrivacyBoundary.test.ts').write_text(r'''import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('server privacy boundary', () => {
  it('never sends an Aegis private message to server AI moderation', () => {
    const moderation = source('../../../../supabase/functions/message-moderation/index.ts');
    expect(moderation).toContain('e2ee_client_private');
    expect(moderation).toContain('authoritativeMessage.sender_id !== user.id');
    expect(moderation).toContain('bodyKind !== "system" || storedBody !== messageBody');
  });

  it('uses generic notification text for private messages', () => {
    const push = source('../../../../supabase/functions/push-notify/index.ts');
    expect(push).toContain('isPrivateMessagePush');
    expect(push).toContain('Ouvre ForSure pour le déchiffrer.');
    expect(push).not.toContain('title, body: msgBody || ""');
  });
});
''', encoding='utf-8')

# Extend audit document.
target = Path('docs/AEGIS_SIGNAL_AUDIT_V2.md')
source = target.read_text(encoding='utf-8')
source += r'''

## Server privacy boundaries

The protocol can remain end-to-end encrypted only if auxiliary services do not
receive message previews. The hardening therefore:

- redacts likely keys, ciphertext, tokens, plaintext fields and arbitrary nested
  metadata before crypto diagnostics leave the device;
- permits server AI moderation only for a server-readable `system` message that
  belongs to the authenticated sender and exactly matches the stored body;
- skips every Aegis `multi_device` row without sending it to an AI provider;
- replaces private-message push previews with generic text.

This preserves content privacy but means automated server moderation cannot read
ordinary E2EE conversations. Abuse reporting must use explicit client-side
selection/upload with user consent rather than silent server scanning.
'''
target.write_text(source, encoding='utf-8')

print('Metadata privacy boundaries generated')
