import { useCallback, useRef } from 'react';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSendMessage } from '@/hooks/useMessages';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { useUXMode } from '@/hooks/useUXMode';
import { readFeedCustomization, writeFeedCustomization } from '@/hooks/useFeedCustomization';
import { zeusCommandSchema, type ZeusCommand } from '@/lib/zeusCommands';
import { zeusCommandFingerprint } from '@/lib/zeusCapabilities';
import { requireZeusCapability, claimZeusCommand } from '@/lib/zeusRuntime';
import { loadZeusActivity, formatZeusActivity } from '@/lib/zeusActivity';
import { findZeusFriendRequests, friendRequestProfilePath } from '@/lib/zeusFriendRequests';
import { syncFeedPrefsFromServer, undoFeedPreferenceChange } from '@/lib/feedPreferences';
import type { ZeusRecipient } from '@/lib/zeusRecipients';

export interface ZeusCommandReceipt { ok: boolean; message: string; navigateTo?: string; undo?: () => Promise<void>; }

export function useZeusCommands() {
  const { mutateAsync: secureSend } = useSendMessage();
  const { requestCall } = useChatWidget();
  const { mode } = useUXMode();
  const queryClient = useQueryClient();
  const attempted = useRef(new Map<string, ZeusCommandReceipt | null>());

  const execute = useCallback(async (raw: ZeusCommand, recipient: ZeusRecipient | undefined, key: string, fromVoice = false, preparedAt = Date.now(), confirmed = false): Promise<ZeusCommandReceipt> => {
    let submitted = false;
    let attemptKey: string | undefined;
    try {
      const command = zeusCommandSchema.parse(raw);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Reconnecte-toi pour exécuter cette demande.');
      attemptKey = `${session.user.id}:${key}`;
      if (attempted.current.has(attemptKey)) return attempted.current.get(attemptKey) ?? { ok: false, message: 'Cette demande a déjà été lancée. Vérifie son résultat avant de recommencer.' };
      attempted.current.set(attemptKey, null);
      const capability = await requireZeusCapability(command.type, fromVoice);
      if (capability.requiresConfirmation && !confirmed) throw new Error('Confirme d’abord la proposition.');
      const assertSameActor = async () => {
        const current = await supabase.auth.getSession();
        if (current.data.session?.user.id !== session.user.id) throw new Error('Le compte connecté a changé.');
      };
      const finish = (receipt: ZeusCommandReceipt) => { attempted.current.set(attemptKey!, receipt); return receipt; };

      if (command.type === 'read_activity') {
        const activity = await loadZeusActivity(session.user.id);
        queryClient.setQueryData(['zeus-activity', session.user.id], activity);
        return finish({ ok: true, message: formatZeusActivity(activity) });
      }
      if (command.type === 'list_friend_requests') {
        const requests = await findZeusFriendRequests();
        await assertSameActor();
        const names = requests.slice(0, 50).map(request => request.name).join(', ');
        return finish({ ok: true, message: names ? `Voici les demandes d’amis reçues : ${names}.${requests.length > 50 ? ' Il y en a d’autres ; précise un nom pour les retrouver.' : ''} Tu peux me demander d’afficher un profil avant de répondre.` : 'Tu n’as aucune demande d’ami en attente.' });
      }
      if (command.type === 'show_friend_request_profile') {
        const requests = await findZeusFriendRequests(command.requester_name);
        await assertSameActor();
        const request = requests.find(item => item.requester_id === recipient?.user_id);
        if (!request || requests.filter(item => item.requester_id === recipient?.user_id).length !== 1) throw new Error('Choisis une demande d’ami encore en attente.');
        return finish({ ok: true, message: `Voici le profil de ${request.name}.`, navigateTo: friendRequestProfilePath(request.requester_id) });
      }

      if (command.type === 'respond_friend_request' || command.type === 'update_feed_config') {
        if (command.type === 'respond_friend_request' && !recipient?.friendship_id) throw new Error('Choisis la demande d’ami à laquelle répondre.');
        const action = command.type === 'respond_friend_request'
          ? { type: command.type, friendship_id: recipient!.friendship_id!, decision: command.decision }
          : { type: command.type, summary: command.summary, command: command.command };
        submitted = true;
        await assertSameActor();
        const { data, error } = await supabase.rpc('zeus_execute_personal_command', {
          p_key: key, p_action: action, p_prepared_at: new Date(preparedAt).toISOString(), p_from_voice: fromVoice, p_confirmed: confirmed,
        });
        if (error) throw new Error('Le serveur n’a pas confirmé cette modification. Vérifie son état avant de réessayer.');
        if (command.type === 'respond_friend_request') {
          const receipt = z.object({ friendship_id: z.string().uuid(), requester_id: z.string().uuid(), decision: z.enum(['accepted', 'rejected']) }).parse(data);
          if (receipt.friendship_id !== recipient!.friendship_id || receipt.requester_id !== recipient!.user_id || receipt.decision !== (command.decision === 'accept' ? 'accepted' : 'rejected')) throw new Error('La réponse à cette demande n’a pas été confirmée.');
          await Promise.all(['friendships', 'friendship-status', 'zeus-activity', 'notifications'].map(name => queryClient.invalidateQueries({ queryKey: [name] })));
          return finish({ ok: true, message: `La demande d’ami de ${recipient!.name} a été ${receipt.decision === 'accepted' ? 'acceptée' : 'refusée'}.` });
        }
        const receipt = z.object({ change_id: z.string().uuid() }).parse(data);
        await syncFeedPrefsFromServer(session.user.id);
        await queryClient.invalidateQueries({ queryKey: ['posts'] });
        return finish({ ok: true, message: 'Ton feed est personnalisé.', undo: async () => {
          await assertSameActor(); await undoFeedPreferenceChange(receipt.change_id); await syncFeedPrefsFromServer(session.user.id);
          await queryClient.invalidateQueries({ queryKey: ['posts'] });
        } });
      }

      if (command.type === 'send_message' || command.type === 'start_call') {
        if (!recipient) throw new Error('Choisis la personne à contacter.');
        const verified = await supabase.from('profiles').select('user_id,name').eq('user_id', recipient.user_id).maybeSingle();
        if (verified.error || verified.data?.user_id !== recipient.user_id) throw new Error('Le destinataire n’est plus disponible.');
      }
      const fingerprint = await zeusCommandFingerprint(command, recipient?.user_id);
      await assertSameActor();
      await claimZeusCommand(key, command.type, fingerprint, preparedAt, fromVoice, confirmed);
      submitted = true;
      await assertSameActor();

      if (command.type === 'update_feed_appearance') {
        const before = readFeedCustomization(mode);
        const next = { ...before, ...(command.font_family !== undefined ? { fontFamily: command.font_family } : {}), ...(command.text_color !== undefined ? { textColor: command.text_color } : {}), ...(command.background_color !== undefined ? { bgColor: command.background_color } : {}) };
        writeFeedCustomization(mode, next);
        return finish({ ok: true, message: 'L’apparence de ton feed est modifiée sur cet appareil.', undo: async () => {
          await assertSameActor();
          if (JSON.stringify(readFeedCustomization(mode)) !== JSON.stringify(next)) throw new Error('L’apparence a changé depuis cette commande.');
          writeFeedCustomization(mode, before);
        } });
      }
      if (command.type === 'publish_post') {
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-actions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          body: JSON.stringify({ action: command, command_key: key, from_voice: fromVoice }),
        });
        const result = await response.json();
        if (!response.ok || result.success !== true || !z.string().uuid().safeParse(result.post_id).success) throw new Error('La publication n’a pas été confirmée. Vérifie ton feed avant de réessayer.');
        await queryClient.invalidateQueries({ queryKey: ['posts'] });
        return finish({ ok: true, message: 'Ta publication est publiée sur le feed.' });
      }
      const dm = await supabase.rpc('create_or_get_dm_conversation', { p_other_user: recipient!.user_id });
      if (dm.error || !z.string().uuid().safeParse(dm.data).success) throw new Error('La conversation n’a pas pu être ouverte.');
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (command.type === 'send_message') {
        const sent = await secureSend({ conversationId: dm.data, body: command.message_text });
        if (!sent?.id) throw new Error('L’envoi du message n’a pas été confirmé.');
        await queryClient.invalidateQueries({ queryKey: ['conversations'] });
        return finish({ ok: true, message: `Message envoyé à ${recipient!.name}.` });
      }
      const message = await requestCall({ actorId: session.user.id, recipientId: recipient!.user_id, conversationId: dm.data, type: command.call_type });
      return finish({ ok: true, message });
    } catch (error) {
      if (!submitted && attemptKey) attempted.current.delete(attemptKey);
      return { ok: false, message: error instanceof Error ? error.message : 'Le résultat de la demande n’a pas été confirmé.' };
    }
  }, [secureSend, requestCall, queryClient, mode]);
  return { execute };
}
