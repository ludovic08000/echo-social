import { useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { ShareButton } from '@/components/ShareButton';
import { type NewsDiscussion, isNewsId, newsError } from '@/lib/newsDiscussion';
import { safePartnerUrl } from '@/lib/discovery';

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw error;
  return data as unknown;
}
export function NewsDiscussionPanel({ threadId }: { threadId: string }) {
  const { user } = useAuth();
  return <AccountDiscussion key={`${user?.id}:${threadId}`} threadId={threadId} userId={user?.id} />;
}
function AccountDiscussion({ threadId, userId }: { threadId: string; userId?: string }) {
  const cache = useQueryClient();
  const [body, setBody] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState('');
  const submission = useRef<{ signature: string; id: string } | null>(null);
  const queryKey = ['news-discussion', userId, threadId];
  const query = useInfiniteQuery({
    queryKey, enabled: !!userId && isNewsId(threadId), retry: false, staleTime: 15_000, refetchInterval: 30_000,
    initialPageParam: null as { time: string; id: string } | null,
    queryFn: async ({ pageParam }) => await rpc('get_news_discussion', {
      p_thread: threadId, p_after_time: pageParam?.time ?? null, p_after_id: pageParam?.id ?? null,
    }) as NewsDiscussion | null,
    getNextPageParam: page => {
      const last = page?.comments[49];
      return page && page.comments.length > 50 && last ? { time: last.created_at, id: last.id } : undefined;
    },
  });
  const thread = query.data?.pages[0];
  const comments = [...new Map((query.data?.pages.flatMap(p => p?.comments.slice(0, 50) ?? []) ?? []).map(c => [c.id, c])).values()];
  const ids = [...new Set(comments.flatMap(c => c.user_id ? [c.user_id] : []))].sort();
  const profiles = useQuery({
    queryKey: ['news-comment-profiles', userId, ids], enabled: !!userId && ids.length > 0, staleTime: 60_000, retry: false,
    queryFn: async () => {
      // Normal profile RLS applies: the discussion RPC never bypasses it to expose names.
      const { data, error } = await supabase.from('profiles').select('user_id,name').in('user_id', ids);
      if (error) throw error;
      return new Map(data.map(p => [p.user_id, p.name]));
    },
  });
  const action = async (name: string, args: Record<string, unknown>, done?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice('');
    try {
      const result = await rpc(name, args);
      if (result === false && name === 'remove_news_comment') throw new Error('NOT_REMOVED');
      done?.();
      setNotice(name === 'report_news_comment' ? 'Signalement transmis à la modération.' : 'Action enregistrée.');
      await cache.invalidateQueries({ queryKey });
    } catch (error) { setNotice(newsError(error)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  if (!userId) return <p>Connecte-toi pour participer à cette discussion. <Link to="/login">Connexion</Link></p>;
  if (!isNewsId(threadId)) return <p>Discussion introuvable.</p>;
  if (query.isLoading) return <p role="status">Chargement de la discussion…</p>;
  if (query.isError) return <div role="alert">Discussion indisponible. <Button onClick={() => void query.refetch()}>Réessayer</Button></div>;
  if (!thread) return <p>Discussion introuvable ou non accessible à ton compte.</p>;
  const source = safePartnerUrl(thread.canonical_url);
  return <section className="p-4 space-y-4" aria-label="Discussion de l’actualité">
    <h1 className="text-xl font-bold">{thread.article?.title ?? 'Discussion d’une actualité archivée'}</h1>
    <p className="text-sm text-muted-foreground">Source : {thread.source_name}. Les commentaires sont ceux des membres de ForSure, pas ceux du journal.</p>
    {thread.article?.excerpt && <p>{thread.article.excerpt}</p>}
    {!thread.article && <p className="text-sm">L’extrait n’est plus disponible ; la discussion et le lien vers le journal sont conservés.</p>}
    {source && <a className="underline" href={source} target="_blank" rel="noopener noreferrer">Lire chez l’éditeur</a>}
    <ShareButton url={`${window.location.origin}/news/${threadId}`} title={`Discussion · ${thread.source_name}`} showLabel size="sm" />
    <p className="text-sm text-muted-foreground">Échange public : respecte les personnes et évite de recopier les articles.</p>
    {query.isFetching && !query.isFetchingNextPage && <p role="status">Actualisation…</p>}
    <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Actualiser les commentaires</Button>
    <ol className="space-y-3">{comments.map(comment => <li id={`comment-${comment.id}`} key={comment.id} className={`border rounded-lg p-3 ${comment.parent_id ? 'ml-4' : ''}`}>
      <p className="text-xs text-muted-foreground">{comment.user_id ? profiles.data?.get(comment.user_id) ?? 'Membre ForSure' : 'Compte supprimé'} · {new Date(comment.created_at).toLocaleString('fr-FR')}</p>
      {comment.parent_id && <a className="text-xs underline" href={`#comment-${comment.parent_id}`}>En réponse à un commentaire</a>}
      <p className="whitespace-pre-wrap break-words">{comment.removed ? 'Commentaire supprimé.' : comment.body}</p>
      {!comment.removed && <div className="flex flex-wrap gap-2 mt-2">
        <Button size="sm" variant="ghost" disabled={busy || thread.locked} onClick={() => setParent(comment.parent_id ?? comment.id)}>Répondre</Button>
        {comment.user_id === userId ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action('remove_news_comment', { p_id: comment.id })}>Supprimer</Button>
          : comment.user_id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReporting(comment.id)}>Signaler</Button>}
      </div>}
      {reporting === comment.id && <div role="group" aria-label="Motif du signalement" className="flex flex-wrap gap-2">
        {([['spam','Spam'],['harassment','Harcèlement'],['other','Autre abus']] as const).map(([reason,label]) =>
          <Button size="sm" key={reason} disabled={busy} onClick={() => void action('report_news_comment',{p_id:comment.id,p_reason:reason},()=>setReporting(null))}>{label}</Button>)}
        <Button size="sm" variant="ghost" onClick={() => setReporting(null)}>Annuler</Button>
      </div>}
    </li>)}</ol>
    {!comments.length && <p>Sois le premier à lancer la discussion.</p>}
    {query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Afficher la suite</Button>}
    {thread.locked ? <p>Cette discussion est fermée par la modération.</p> : <form className="space-y-2" onSubmit={e => {
      e.preventDefault(); if (!body.trim() || busy) return;
      const signature = JSON.stringify([body.trim(),parent]);
      if (submission.current?.signature !== signature) submission.current = {signature,id:crypto.randomUUID()};
      void action('add_news_comment', {p_thread:threadId,p_id:submission.current.id,p_body:body.trim(),p_parent:parent}, () => {
        setBody(''); setParent(null); submission.current=null;
      });
    }}>
      {parent && <p>Réponse à un commentaire <Button type="button" variant="ghost" onClick={() => setParent(null)}>Annuler la réponse</Button></p>}
      <label className="block">Ton commentaire<textarea className="block w-full bg-background border rounded p-2" maxLength={1000} value={body} disabled={busy} onChange={e=>setBody(e.target.value)} /></label>
      <Button type="submit" disabled={busy || !body.trim()}>{busy ? 'Enregistrement…' : 'Publier le commentaire'}</Button>
    </form>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
