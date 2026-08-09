import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import { sendAegisOutboundMessage } from '@/lib/messaging/aegisOutboundEngine';
import {
  acknowledgeAegisMessage,
  syncAegisDeviceInbox,
  type AegisInboxRow,
} from '@/lib/messaging/aegisDeviceInbox';
import { clearE2EETrace, readE2EETrace, type E2EETraceEvent } from '@/lib/messaging/e2eeTrace';
import { loadPlaintext } from '@/lib/crypto/plaintextStore';

interface LogEntry {
  at: string;
  step: string;
  ok: boolean;
  details?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const rpc = supabase.rpc as unknown as (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function waitForPlaintext(messageId: string, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const plaintext = await loadPlaintext(messageId);
    if (plaintext) return plaintext;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export default function E2EEDeviceEnrollmentTest() {
  const { user } = useAuth();
  const [peerUserId, setPeerUserId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [plaintext, setPlaintext] = useState('Test réel iOS ↔ Windows — Echo Social E2EE');
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [lastMessageId, setLastMessageId] = useState('');
  const [lastInbox, setLastInbox] = useState<AegisInboxRow[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [traces, setTraces] = useState<E2EETraceEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const addLog = useCallback((step: string, ok: boolean, details?: unknown) => {
    setLogs((current) => [...current, { at: new Date().toISOString(), step, ok, details }]);
  }, []);

  const refreshTraces = useCallback(() => {
    setTraces(readE2EETrace());
  }, []);

  useEffect(() => {
    refreshTraces();
    const onTrace = () => refreshTraces();
    window.addEventListener('forsure:e2ee-trace', onTrace);
    return () => window.removeEventListener('forsure:e2ee-trace', onTrace);
  }, [refreshTraces]);

  useEffect(() => {
    if (!user?.id) return;
    void ensureAegisDeviceReady(user.id)
      .then((ready) => {
        setCurrentDeviceId(ready.deviceId);
        addLog('device:ready', true, { deviceId: ready.deviceId });
      })
      .catch((error) => addLog('device:ready', false, error instanceof Error ? error.message : String(error)));
  }, [addLog, user?.id]);

  const canResolve = Boolean(user?.id && UUID_RE.test(peerUserId) && peerUserId !== user.id);
  const canSend = Boolean(user?.id && conversationId && plaintext.trim());

  const resolveConversation = useCallback(async () => {
    if (!user?.id || !canResolve || busy) return;
    setBusy(true);
    try {
      const { data, error } = await rpc('create_or_get_dm_conversation', { p_other_user: peerUserId });
      if (error) throw new Error(error.message);
      if (typeof data !== 'string' || !UUID_RE.test(data)) throw new Error('DM_CONVERSATION_INVALID');
      setConversationId(data);
      addLog('conversation:resolved', true, { conversationId: data, peerUserId });
    } catch (error) {
      addLog('conversation:resolved', false, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [addLog, busy, canResolve, peerUserId, user?.id]);

  const sendRealMessage = useCallback(async () => {
    if (!user?.id || !canSend || busy) return;
    setBusy(true);
    try {
      const result = await sendAegisOutboundMessage({
        conversationId,
        senderUserId: user.id,
        plaintext: plaintext.trim(),
      });
      setLastMessageId(result.id);
      addLog('send:real-ui-engine', true, {
        messageId: result.id,
        copyCount: result.copies.length,
        retriedStaleRoute: result.retriedStaleRoute,
      });
      refreshTraces();
    } catch (error) {
      addLog('send:real-ui-engine', false, error instanceof Error ? error.message : String(error));
      refreshTraces();
    } finally {
      setBusy(false);
    }
  }, [addLog, busy, canSend, conversationId, plaintext, refreshTraces, user?.id]);

  const syncRealInbox = useCallback(async () => {
    if (!user?.id || busy) return;
    setBusy(true);
    try {
      const rows = await syncAegisDeviceInbox(user.id);
      setLastInbox(rows);
      addLog('sync:real-ui-inbox', true, {
        count: rows.length,
        messageIds: rows.map((row) => row.message_id),
      });

      for (const row of rows) {
        const decrypted = await waitForPlaintext(row.message_id);
        addLog('decrypt:real-ui-pipeline', Boolean(decrypted), {
          messageId: row.message_id,
          persistedPlaintext: Boolean(decrypted),
          exactPreview: decrypted ? decrypted.slice(0, 120) : null,
        });
      }
      refreshTraces();
    } catch (error) {
      addLog('sync:real-ui-inbox', false, error instanceof Error ? error.message : String(error));
      refreshTraces();
    } finally {
      setBusy(false);
    }
  }, [addLog, busy, refreshTraces, user?.id]);

  const ackLast = useCallback(async (markRead: boolean) => {
    if (!user?.id || !lastMessageId || busy) return;
    setBusy(true);
    try {
      await acknowledgeAegisMessage(user.id, lastMessageId, markRead);
      addLog(markRead ? 'ack:read' : 'ack:delivered', true, { messageId: lastMessageId });
      refreshTraces();
    } catch (error) {
      addLog(markRead ? 'ack:read' : 'ack:delivered', false, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [addLog, busy, lastMessageId, refreshTraces, user?.id]);

  const traceSummary = useMemo(() => traces.slice(-80).reverse(), [traces]);

  if (!user) return null;

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="space-y-2">
          <p className="text-xs text-muted-foreground">Diagnostic réel · mêmes moteurs que la messagerie Echo Social</p>
          <h1 className="text-2xl font-semibold">Test réel iOS ↔ Windows — E2EE</h1>
          <p className="text-sm text-muted-foreground">
            Ouvre cette page sur deux appareils avec deux comptes de test. Le test utilise le moteur d’envoi, le runtime inbox, le déchiffrement global et les ACK de l’application — aucune crypto de démonstration.
          </p>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <h2 className="font-medium">Cet appareil</h2>
            <div className="text-xs break-all"><strong>User ID :</strong> {user.id}</div>
            <div className="text-xs break-all"><strong>Device ID :</strong> {currentDeviceId || 'détection…'}</div>
            <p className="text-xs text-muted-foreground">Copie le User ID de cet appareil sur l’autre appareil.</p>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <h2 className="font-medium">Pair distant</h2>
            <input
              value={peerUserId}
              onChange={(event) => setPeerUserId(event.target.value.trim())}
              placeholder="UUID utilisateur de l’autre appareil"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={!canResolve || busy}
              onClick={resolveConversation}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              Créer / retrouver la conversation réelle
            </button>
            {conversationId ? <div className="text-xs break-all">Conversation : {conversationId}</div> : null}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4 space-y-3">
          <h2 className="font-medium">Envoi réel</h2>
          <textarea
            value={plaintext}
            onChange={(event) => setPlaintext(event.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!canSend || busy} onClick={sendRealMessage} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
              Envoyer via le vrai moteur E2EE
            </button>
            <button type="button" disabled={busy} onClick={syncRealInbox} className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50">
              Synchroniser ce device
            </button>
            <button type="button" disabled={!lastMessageId || busy} onClick={() => ackLast(false)} className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50">
              ACK delivered
            </button>
            <button type="button" disabled={!lastMessageId || busy} onClick={() => ackLast(true)} className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50">
              ACK read
            </button>
            {conversationId ? (
              <Link to={`/messages/${conversationId}`} className="rounded-md border border-border px-4 py-2 text-sm">
                Ouvrir la vraie UI Messages
              </Link>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Sur le destinataire : clique « Synchroniser ce device ». Si le runtime UI déchiffre réellement, le journal affiche `decrypt:real-ui-pipeline = OK`. Ouvre ensuite la conversation dans Messages pour vérifier l’affichage et le read ACK.
          </p>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-medium">Journal de test</h2>
            <span className="text-xs text-muted-foreground">Inbox actuel : {lastInbox.length}</span>
          </div>
          <div className="space-y-2">
            {logs.length === 0 ? <p className="text-sm text-muted-foreground">Aucune action.</p> : logs.slice().reverse().map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="rounded-md border border-border bg-background p-3 text-xs">
                <div className="flex justify-between gap-3"><strong>{entry.ok ? 'PASS' : 'FAIL'} — {entry.step}</strong><span>{entry.at}</span></div>
                {entry.details !== undefined ? <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(entry.details, null, 2)}</pre> : null}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">Traces E2EE internes</h2>
            <div className="flex gap-2">
              <button type="button" onClick={refreshTraces} className="rounded-md border border-border px-3 py-1.5 text-xs">Rafraîchir</button>
              <button type="button" onClick={() => { clearE2EETrace(); refreshTraces(); }} className="rounded-md border border-border px-3 py-1.5 text-xs">Effacer</button>
            </div>
          </div>
          <div className="max-h-[520px] space-y-2 overflow-auto">
            {traceSummary.length === 0 ? <p className="text-sm text-muted-foreground">Aucune trace.</p> : traceSummary.map((trace) => (
              <div key={trace.seq} className="rounded-md border border-border bg-background p-2 text-xs">
                <strong>#{trace.seq} {trace.direction} · {trace.component ?? '-'} · {trace.stage}</strong>
                <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(trace, null, 2)}</pre>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
