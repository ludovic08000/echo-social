import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  CheckCircle2,
  CircleAlert,
  Database,
  Inbox,
  Loader2,
  Monitor,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { AppLayout } from '@/components/AppLayout';
import { DecryptedMessageBody } from '@/components/messages/DecryptedMessageBody';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth';
import { deviceApi, type DeviceApiListRecord, type DeviceApiSnapshot } from '@/lib/api/deviceApi';
import { messagingApi } from '@/lib/api/messagingApi';
import { supabase } from '@/integrations/supabase/client';
import {
  getDeviceIdStatus,
  peekCurrentDeviceId,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';
import {
  detectDevicePlatformKind,
  resolveDevicePlatformProvider,
  type DevicePlatformKind,
} from '@/platforms/deviceLifecycleCore';
import {
  ZEUS_BOT_ID,
  useConversations,
  useCreateConversation,
  useMarkConversationRead,
  useMessages,
  useSendMessage,
} from '@/hooks/useMessages';
import { useE2EE } from '@/hooks/useE2EE';
import { toast } from 'sonner';

type CopyRow = {
  id: string;
  message_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  sender_device_id: string;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
};

type LogEntry = {
  id: number;
  at: string;
  kind: 'info' | 'ok' | 'error';
  text: string;
};

function shortId(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length <= 22) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function platformLabel(kind: DevicePlatformKind): string {
  if (kind === 'ios') return 'iOS';
  if (kind === 'windows') return 'Windows';
  return 'Web / générique';
}

function inferStoredDevicePlatform(
  device: DeviceApiListRecord,
  currentDeviceId: string | null,
  runtimePlatform: DevicePlatformKind,
): string {
  if (device.deviceId === currentDeviceId && runtimePlatform !== 'generic') {
    return platformLabel(runtimePlatform);
  }
  const ua = device.userAgent ?? '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  return device.platform || 'Web';
}

function statusClass(ok: boolean): string {
  return ok
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

export default function DeviceMessagingTest() {
  const { user, loading: authLoading } = useAuth();
  const conversationsQuery = useConversations();
  const sendMessage = useSendMessage();
  const createConversation = useCreateConversation();
  const markConversationRead = useMarkConversationRead();

  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [messageText, setMessageText] = useState('Test Aegis iOS ↔ Windows');
  const [peerUserIdInput, setPeerUserIdInput] = useState('');
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceApiSnapshot | null>(null);
  const [devices, setDevices] = useState<DeviceApiListRecord[]>([]);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [providerSupported, setProviderSupported] = useState<boolean | null>(null);
  const [providerRegistered, setProviderRegistered] = useState<boolean | null>(null);
  const [copies, setCopies] = useState<CopyRow[]>([]);
  const [copiesLoading, setCopiesLoading] = useState(false);
  const [syncingInbox, setSyncingInbox] = useState(false);
  const [decryptedIds, setDecryptedIds] = useState<Record<string, true>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logSeq = useRef(0);
  const lastObservedMessageId = useRef<string | null>(null);

  const runtimePlatform = useMemo(() => detectDevicePlatformKind(), []);
  const currentDeviceId = deviceSnapshot?.record?.deviceId ?? (user ? deviceApi.getCurrentId(user.id) : null) ?? peekCurrentDeviceId();
  const currentDeviceIdStatus = getDeviceIdStatus();

  const addLog = useCallback((kind: LogEntry['kind'], text: string) => {
    const entry: LogEntry = {
      id: ++logSeq.current,
      at: new Date().toLocaleTimeString('fr-FR'),
      kind,
      text,
    };
    setLogs((current) => [entry, ...current].slice(0, 40));
  }, []);

  const refreshDeviceDiagnostics = useCallback(async () => {
    if (!user?.id) return;
    setDeviceLoading(true);
    try {
      setCurrentDeviceUserScope(user.id);
      const provider = resolveDevicePlatformProvider();
      const [snapshot, ownDevices, supported] = await Promise.all([
        deviceApi.getState(user.id),
        deviceApi.listDevices(user.id),
        provider.isSupported(),
      ]);
      const id = snapshot.record?.deviceId ?? deviceApi.getCurrentId(user.id);
      const registered = supported && id ? await provider.getStatus(id) : false;
      setDeviceSnapshot(snapshot);
      setDevices(ownDevices);
      setProviderSupported(supported);
      setProviderRegistered(registered);
      addLog('ok', `Diagnostic device actualisé · ${platformLabel(runtimePlatform)} · ${snapshot.state}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('error', `Diagnostic device impossible · ${message}`);
    } finally {
      setDeviceLoading(false);
    }
  }, [addLog, runtimePlatform, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    void refreshDeviceDiagnostics();
    const refresh = () => void refreshDeviceDiagnostics();
    const events = [
      'forsure:device-approved',
      'forsure:device-account-bound',
      'forsure:aegis-route-ready',
      'forsure:webauthn-device-restored',
      'forsure:authenticated-device-enroll',
    ];
    events.forEach((name) => window.addEventListener(name, refresh));
    return () => events.forEach((name) => window.removeEventListener(name, refresh));
  }, [refreshDeviceDiagnostics, user?.id]);

  const conversations = useMemo(
    () => (conversationsQuery.data ?? []).filter((conversation) => conversation.participant?.user_id !== ZEUS_BOT_ID),
    [conversationsQuery.data],
  );

  useEffect(() => {
    if (selectedConversationId || conversations.length === 0) return;
    setSelectedConversationId(conversations[0].id);
  }, [conversations, selectedConversationId]);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const peerUserId = selectedConversation?.participant?.user_id || undefined;
  const e2ee = useE2EE(selectedConversationId || undefined, peerUserId);
  const messagesQuery = useMessages(selectedConversationId);
  const messages = messagesQuery.data ?? [];

  const recentMessageIds = useMemo(() => messages.slice(-30).map((message) => message.id), [messages]);
  const recentMessageIdsKey = recentMessageIds.join(',');

  const refreshCopies = useCallback(async () => {
    if (!user?.id || recentMessageIds.length === 0) {
      setCopies([]);
      return;
    }
    setCopiesLoading(true);
    try {
      const { data, error } = await supabase
        .from('message_device_copies')
        .select('id,message_id,recipient_user_id,recipient_device_id,sender_user_id,sender_device_id,created_at,delivered_at,read_at')
        .in('message_id', recentMessageIds)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setCopies((data ?? []) as CopyRow[]);
    } catch (error) {
      addLog('error', `Lecture routage device impossible · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCopiesLoading(false);
    }
  }, [addLog, recentMessageIds, user?.id]);

  useEffect(() => {
    void refreshCopies();
  }, [recentMessageIdsKey, refreshCopies]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.id === lastObservedMessageId.current) return;
    lastObservedMessageId.current = last.id;
    if (last.sender_id === user?.id) {
      addLog('ok', `Message local observé · ${shortId(last.id)}`);
    } else {
      addLog('ok', `Message reçu en temps réel · ${shortId(last.id)} · expéditeur ${shortId(last.sender_id)}`);
    }
  }, [addLog, messages, user?.id]);

  const copiesByMessage = useMemo(() => {
    const map = new Map<string, CopyRow[]>();
    for (const copy of copies) {
      const current = map.get(copy.message_id) ?? [];
      current.push(copy);
      map.set(copy.message_id, current);
    }
    return map;
  }, [copies]);

  const sendTestMessage = async () => {
    if (!selectedConversationId || !messageText.trim()) return;
    addLog('info', `Envoi Aegis demandé · conversation ${shortId(selectedConversationId)}`);
    try {
      const sent = await sendMessage.mutateAsync({
        conversationId: selectedConversationId,
        body: messageText.trim(),
      });
      addLog('ok', `Envoi Aegis confirmé · message ${shortId(sent.id)} · device ${shortId(currentDeviceId)}`);
      setMessageText(`Test Aegis ${platformLabel(runtimePlatform)} ${new Date().toLocaleTimeString('fr-FR')}`);
      await messagesQuery.refetch();
      window.setTimeout(() => void refreshCopies(), 400);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('error', `Échec envoi · ${message}`);
      toast.error(message);
    }
  };

  const syncInbox = async () => {
    if (!user?.id) return;
    setSyncingInbox(true);
    addLog('info', `Synchronisation inbox Aegis · device ${shortId(currentDeviceId)}`);
    try {
      await messagingApi.syncInbox(user.id);
      await messagesQuery.refetch();
      await refreshCopies();
      addLog('ok', 'Inbox Aegis synchronisée avec le runtime canonique');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('error', `Échec sync inbox · ${message}`);
      toast.error(message);
    } finally {
      setSyncingInbox(false);
    }
  };

  const markRead = async () => {
    if (!selectedConversationId) return;
    try {
      await markConversationRead.mutateAsync(selectedConversationId);
      addLog('ok', `Conversation marquée lue · ${shortId(selectedConversationId)}`);
      window.setTimeout(() => void refreshCopies(), 300);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('error', `Échec lecture · ${message}`);
    }
  };

  const createOrOpenDm = async () => {
    const target = peerUserIdInput.trim();
    if (!target || target === user?.id || target === ZEUS_BOT_ID) return;
    try {
      const conversation = await createConversation.mutateAsync(target);
      setSelectedConversationId(conversation.id);
      setPeerUserIdInput('');
      addLog('ok', `DM ouvert · ${shortId(conversation.id)} · pair ${shortId(target)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog('error', `Impossible d’ouvrir le DM · ${message}`);
      toast.error(message);
    }
  };

  if (authLoading) {
    return <div className="min-h-screen grid place-items-center bg-background"><Loader2 className="h-7 w-7 animate-spin" /></div>;
  }
  if (!user) return <Navigate to="/login" replace />;

  const localDeviceReady = deviceSnapshot?.state === 'ready' && currentDeviceIdStatus === 'ok';
  const passkeyLabel = runtimePlatform === 'windows' ? 'Windows Hello' : runtimePlatform === 'ios' ? 'Passkey iOS' : 'Passkey plateforme';

  return (
    <AppLayout fullWidth>
      <div className="mx-auto w-full max-w-7xl space-y-5 p-4 pb-24 sm:p-6">
        <div className="flex flex-col gap-3 rounded-3xl border border-border/60 bg-card/70 p-5 shadow-sm backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <ShieldCheck className="h-4 w-4" /> Diagnostic isolé · Aegis E2EE
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Test Device iOS ↔ Windows</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Attribution du DeviceID, état lifecycle, routage par device, envoi réel Aegis, réception/synchronisation et déchiffrement.
              Aucun enrôlement, aucune récupération et aucune mutation du provider Windows ne sont déclenchés par cette page.
            </p>
          </div>
          <Button variant="outline" onClick={() => void refreshDeviceDiagnostics()} disabled={deviceLoading}>
            {deviceLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Rafraîchir device
          </Button>
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${statusClass(localDeviceReady)}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide">Device courant</span>
              {runtimePlatform === 'windows' ? <Monitor className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
            </div>
            <div className="mt-3 text-lg font-bold">{platformLabel(runtimePlatform)}</div>
            <div className="mt-1 font-mono text-xs">{shortId(currentDeviceId)}</div>
            <div className="mt-2 text-xs">ID: {currentDeviceIdStatus} · lifecycle: {deviceSnapshot?.state ?? 'lecture…'}</div>
          </div>

          <div className={`rounded-2xl border p-4 ${statusClass(providerSupported === true)}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide">Attestation locale</span>
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="mt-3 text-lg font-bold">{passkeyLabel}</div>
            <div className="mt-2 text-xs">Support: {providerSupported == null ? 'lecture…' : providerSupported ? 'oui' : 'non'}</div>
            <div className="text-xs">Enregistré: {providerRegistered == null ? 'lecture…' : providerRegistered ? 'oui' : 'non'}</div>
          </div>

          <div className={`rounded-2xl border p-4 ${statusClass(e2ee.isReady())}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide">E2EE pair</span>
              <Database className="h-5 w-5" />
            </div>
            <div className="mt-3 text-lg font-bold">{e2ee.isReady() ? 'Prêt' : 'Bloqué / attente'}</div>
            <div className="mt-2 text-xs">ratchet: {e2ee.ratchetActive ? 'actif' : 'inactif'} · encrypted: {e2ee.encrypted ? 'oui' : 'non'}</div>
            <div className="text-xs">erreur: {e2ee.initError ?? 'aucune'}</div>
          </div>

          <div className={`rounded-2xl border p-4 ${statusClass(messagesQuery.isSuccess)}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide">Réception</span>
              <Inbox className="h-5 w-5" />
            </div>
            <div className="mt-3 text-lg font-bold">{messages.length} messages</div>
            <div className="mt-2 text-xs">copies device visibles: {copies.length}</div>
            <div className="text-xs">conversation: {shortId(selectedConversationId)}</div>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="space-y-5">
            <section className="rounded-3xl border border-border/60 bg-card/70 p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">Mes devices serveur</h2>
                <span className="text-xs text-muted-foreground">{devices.length}</span>
              </div>
              <div className="space-y-3">
                {devices.map((device) => {
                  const isCurrent = device.deviceId === currentDeviceId;
                  const ready = device.lifecycleStatus === 'ready' && device.routingStatus === 'ready' && device.bindingStatus === 'bound' && device.approvalStatus === 'approved' && device.isActive && !device.revokedAt;
                  return (
                    <div key={device.id} className="rounded-2xl border border-border/50 bg-background/60 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold">
                            {inferStoredDevicePlatform(device, currentDeviceId, runtimePlatform)} {isCurrent ? '· courant' : ''}
                          </div>
                          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{shortId(device.deviceId)}</div>
                        </div>
                        {ready ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <CircleAlert className="h-5 w-5 text-amber-500" />}
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>approval: {device.approvalStatus ?? '—'}</span>
                        <span>binding: {device.bindingStatus ?? '—'}</span>
                        <span>routing: {device.routingStatus ?? '—'}</span>
                        <span>lifecycle: {device.lifecycleStatus ?? '—'}</span>
                      </div>
                    </div>
                  );
                })}
                {!deviceLoading && devices.length === 0 && <p className="text-sm text-muted-foreground">Aucun device serveur visible.</p>}
              </div>
            </section>

            <section className="rounded-3xl border border-border/60 bg-card/70 p-5 shadow-sm">
              <h2 className="font-semibold">Conversation de test</h2>
              <select
                value={selectedConversationId}
                onChange={(event) => setSelectedConversationId(event.target.value)}
                className="mt-3 h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
              >
                <option value="">Choisir une conversation</option>
                {conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.participant?.name || shortId(conversation.participant?.user_id)} · {shortId(conversation.id)}
                  </option>
                ))}
              </select>

              <div className="mt-4 border-t border-border/50 pt-4">
                <p className="mb-2 text-xs text-muted-foreground">Ou ouvrir un DM avec un User ID de test</p>
                <div className="flex gap-2">
                  <Input
                    value={peerUserIdInput}
                    onChange={(event) => setPeerUserIdInput(event.target.value)}
                    placeholder="UUID utilisateur iOS / Windows"
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" onClick={() => void createOrOpenDm()} disabled={createConversation.isPending || !peerUserIdInput.trim()}>
                    Ouvrir
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-border/60 bg-card/70 p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">Journal du test</h2>
                <Button variant="ghost" size="sm" onClick={() => setLogs([])}>Effacer</Button>
              </div>
              <div className="mt-3 max-h-72 space-y-2 overflow-auto font-mono text-[11px]">
                {logs.map((entry) => (
                  <div key={entry.id} className="rounded-xl border border-border/40 bg-background/50 p-2">
                    <span className="text-muted-foreground">{entry.at}</span>{' '}
                    <span className={entry.kind === 'error' ? 'text-destructive' : entry.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : ''}>{entry.text}</span>
                  </div>
                ))}
                {logs.length === 0 && <p className="text-muted-foreground">Aucun événement.</p>}
              </div>
            </section>
          </div>

          <div className="space-y-5">
            <section className="rounded-3xl border border-border/60 bg-card/70 p-5 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold">Envoi / réception réelle</h2>
                  <p className="text-xs text-muted-foreground">Transport utilisé : le même `useSendMessage` sécurisé que le messenger normal.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => void syncInbox()} disabled={syncingInbox || !selectedConversationId}>
                    {syncingInbox ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Inbox className="mr-2 h-4 w-4" />}
                    Sync réception
                  </Button>
                  <Button variant="outline" onClick={() => void markRead()} disabled={!selectedConversationId || markConversationRead.isPending}>
                    Marquer lu
                  </Button>
                  <Button variant="outline" onClick={() => void refreshCopies()} disabled={copiesLoading || !selectedConversationId}>
                    {copiesLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Routage
                  </Button>
                </div>
              </div>

              <div className="mt-4 flex gap-2">
                <Input
                  value={messageText}
                  onChange={(event) => setMessageText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendTestMessage();
                    }
                  }}
                  placeholder="Message test chiffré"
                  disabled={!selectedConversationId}
                />
                <Button
                  onClick={() => void sendTestMessage()}
                  disabled={!selectedConversationId || !messageText.trim() || sendMessage.isPending}
                >
                  {sendMessage.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  <span className="ml-2 hidden sm:inline">Envoyer</span>
                </Button>
              </div>

              <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <div className="rounded-xl border border-border/50 p-2">Pair: <span className="font-mono">{shortId(peerUserId)}</span></div>
                <div className="rounded-xl border border-border/50 p-2">Fingerprint pair: <span className="font-mono">{shortId(e2ee.peerFingerprint)}</span></div>
                <div className="rounded-xl border border-border/50 p-2">Device local: <span className="font-mono">{shortId(currentDeviceId)}</span></div>
              </div>
            </section>

            <section className="rounded-3xl border border-border/60 bg-card/70 p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Messages et copies par device</h2>
                  <p className="text-xs text-muted-foreground">Les clés et ciphertexts ne sont jamais affichés.</p>
                </div>
                {messagesQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>

              <div className="max-h-[760px] space-y-3 overflow-auto pr-1">
                {messages.slice(-30).map((message) => {
                  const isMe = message.sender_id === user.id;
                  const routes = copiesByMessage.get(message.id) ?? [];
                  return (
                    <article key={message.id} className="rounded-2xl border border-border/50 bg-background/60 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${isMe ? 'bg-primary/10 text-primary' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>
                            {isMe ? 'ENVOYÉ' : 'REÇU'}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">{shortId(message.id)}</span>
                        </div>
                        <span className="text-[11px] text-muted-foreground">{formatDate(message.created_at)} · {message.status}</span>
                      </div>

                      <div className="mt-3 rounded-xl border border-border/40 bg-card/60 p-3 text-sm">
                        <DecryptedMessageBody
                          body={message.body}
                          decrypt={e2ee.decrypt}
                          isEncryptionActive={e2ee.encrypted}
                          isMe={isMe}
                          messageId={message.id}
                          senderId={message.sender_id}
                          archiveBody={message.archive_body}
                          hasMedia={Boolean(message.image_url)}
                          onDecrypted={() => {
                            setDecryptedIds((current) => current[message.id] ? current : { ...current, [message.id]: true });
                          }}
                        />
                      </div>

                      <div className="mt-2 flex items-center gap-2 text-[11px]">
                        <span className={decryptedIds[message.id] ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                          {decryptedIds[message.id] ? '✓ plaintext résolu' : '… résolution plaintext'}
                        </span>
                        <span className="text-muted-foreground">route version: {message.aegis_route_version ?? '—'}</span>
                      </div>

                      <div className="mt-3 space-y-2">
                        {routes.map((copy) => {
                          const localIsSender = copy.sender_device_id === currentDeviceId;
                          const localIsRecipient = copy.recipient_device_id === currentDeviceId;
                          return (
                            <div key={copy.id} className="rounded-xl border border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
                              <div className="flex flex-wrap items-center gap-1 font-mono">
                                <span className={localIsSender ? 'font-bold text-foreground' : ''}>{shortId(copy.sender_device_id)}</span>
                                <span>→</span>
                                <span className={localIsRecipient ? 'font-bold text-foreground' : ''}>{shortId(copy.recipient_device_id)}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                                <span>local: {localIsSender ? `sender ${platformLabel(runtimePlatform)}` : localIsRecipient ? `recipient ${platformLabel(runtimePlatform)}` : 'autre route'}</span>
                                <span>delivered: {copy.delivered_at ? formatDate(copy.delivered_at) : 'non'}</span>
                                <span>read: {copy.read_at ? formatDate(copy.read_at) : 'non'}</span>
                              </div>
                            </div>
                          );
                        })}
                        {routes.length === 0 && <div className="text-[11px] text-muted-foreground">Aucune copie device visible pour ce message.</div>}
                      </div>
                    </article>
                  );
                })}

                {!selectedConversationId && <p className="py-10 text-center text-sm text-muted-foreground">Sélectionne une conversation de test.</p>}
                {selectedConversationId && !messagesQuery.isFetching && messages.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">Aucun message dans cette conversation.</p>}
              </div>
            </section>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
