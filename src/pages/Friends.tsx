import { useState } from 'react';
import { Users, Clock, UserCheck, UserPlus, Search, UserX, MessageCircle, Sparkles, MapPin, Phone, RefreshCw, Mail } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/AppLayout';
import { useFriendships, useRespondToFriendRequest, useRemoveFriend, useSendFriendRequest } from '@/hooks/useFriendships';
import { useCreateConversation } from '@/hooks/useMessages';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { InviteContacts } from '@/components/InviteContacts';
import { FriendSuggestions } from '@/components/feed/FriendSuggestions';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useNewUsers } from '@/hooks/useNewUsers';
import { useContactSync } from '@/hooks/useContactSync';
import { useOAuthContactsImport } from '@/hooks/useOAuthContactsImport';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

export default function Friends() {
  const { data, isLoading } = useFriendships();
  const respondToRequest = useRespondToFriendRequest();
  const removeFriend = useRemoveFriend();
  const sendRequest = useSendFriendRequest();
  const createConversation = useCreateConversation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const { data: newUsers, isLoading: loadingNewUsers } = useNewUsers();
  const contactSync = useContactSync();
  const oauthImport = useOAuthContactsImport();

  // Google Client ID — will be set via secret
  const GOOGLE_CLIENT_ID = ''; // TODO: Set via environment

  const handleAccept = (friendshipId: string) => {
    respondToRequest.mutate(
      { friendshipId, accept: true },
      { onSuccess: () => toast({ title: '🎉 Ami ajouté !' }) }
    );
  };

  const handleReject = (friendshipId: string) => {
    respondToRequest.mutate({ friendshipId, accept: false });
  };

  const handleRemove = (friendshipId: string) => {
    if (confirm('Retirer cet ami ?')) {
      removeFriend.mutate(friendshipId);
    }
  };

  const handleMessage = async (userId: string) => {
    const conv = await createConversation.mutateAsync(userId);
    navigate(`/messages/${conv.id}`);
  };

  const filteredFriends = data?.friends.filter(f =>
    f.profile.name.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const requestCount = data?.requests.length || 0;

  return (
    <AppLayout>
      <header className="mb-5">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Amis
          </h1>
          <Link to="/friend-match">
            <Button variant="outline" size="sm" className="rounded-xl gap-1.5 text-xs">
              <UserPlus className="w-3.5 h-3.5" />
              Découvrir
            </Button>
          </Link>
        </div>
      </header>

      <Tabs defaultValue="new" className="w-full">
        <TabsList className="grid w-full grid-cols-6 rounded-xl h-10">
          <TabsTrigger value="new" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <Sparkles className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Nouveaux</span>
          </TabsTrigger>
          <TabsTrigger value="sync" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <Phone className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Synchro</span>
          </TabsTrigger>
          <TabsTrigger value="friends" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <Users className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Amis</span>
            {data?.friends.length ? (
              <span className="text-[10px] font-medium text-muted-foreground">{data.friends.length}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="requests" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm relative">
            <UserCheck className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Demandes</span>
            {requestCount > 0 && (
              <Badge variant="destructive" className="absolute -top-1 -right-1 h-4 w-4 p-0 flex items-center justify-center text-[9px] rounded-full">
                {requestCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pending" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <Clock className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Envoyées</span>
          </TabsTrigger>
          <TabsTrigger value="invite" className="gap-1.5 text-xs rounded-lg data-[state=active]:shadow-sm">
            <UserPlus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Inviter</span>
          </TabsTrigger>
        </TabsList>

        {/* New Users Tab */}
        <TabsContent value="new" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {loadingNewUsers ? (
              <LoadingSkeleton />
            ) : !newUsers?.length ? (
              <EmptyState
                icon={<Sparkles className="w-10 h-10 text-muted-foreground/40" />}
                message="Aucun nouveau membre"
              />
            ) : (
              newUsers.map(u => (
                <div key={u.user_id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                  <Link to={`/profile/${u.user_id}`} className="flex-shrink-0">
                    <UserAvatar src={u.avatar_url} alt={u.name} size="md" />
                  </Link>
                  <Link to={`/profile/${u.user_id}`} className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{u.name}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-muted-foreground">
                        Inscrit {formatDistanceToNow(new Date(u.created_at), { addSuffix: true, locale: fr })}
                      </p>
                      {u.city && (
                        <span className="text-[10px] text-primary flex items-center gap-0.5">
                          <MapPin className="w-3 h-3" />
                          {u.city}
                        </span>
                      )}
                    </div>
                  </Link>
                  <Button
                    size="sm"
                    className="rounded-xl h-8 text-xs gap-1.5"
                    onClick={() => sendRequest.mutate(u.user_id)}
                    disabled={sendRequest.isPending}
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    Ajouter
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {/* Sync Contacts Tab */}
        <TabsContent value="sync" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden">
            {/* Platform badge */}
            <div className="flex items-center justify-center gap-2 p-3 border-b border-border/20">
              <Badge variant={contactSync.isNative ? 'default' : 'secondary'} className="text-xs">
                {contactSync.platform === 'ios' && '🍎 iPhone détecté'}
                {contactSync.platform === 'android' && '🤖 Android détecté'}
                {contactSync.platform === 'web' && '🌐 Navigateur web'}
              </Badge>
            </div>

            {contactSync.isNative ? (
              /* Native: direct sync button */
              <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Phone className="w-8 h-8 text-primary" />
                </div>
                <h3 className="font-semibold text-lg">Synchroniser mes contacts</h3>
                <p className="text-sm text-muted-foreground max-w-xs">
                  {contactSync.platform === 'ios'
                    ? 'Accédez à votre répertoire iPhone pour retrouver vos amis sur Forsure'
                    : 'Accédez à votre répertoire Android pour retrouver vos amis sur Forsure'}
                </p>
                <Button
                  onClick={contactSync.syncContacts}
                  disabled={contactSync.loading}
                  className="gap-2"
                  size="lg"
                >
                  {contactSync.loading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Phone className="w-4 h-4" />
                  )}
                  {contactSync.loading
                    ? 'Synchronisation...'
                    : contactSync.synced
                    ? 'Resynchroniser'
                    : `Synchro ${contactSync.platform === 'ios' ? 'iPhone' : 'Android'}`}
                </Button>

                {contactSync.synced && (
                  <div className="w-full space-y-3 mt-2">
                    <div className="flex justify-center gap-4 text-sm">
                      <span className="text-primary font-medium">{contactSync.matched.length} trouvé(s)</span>
                      <span className="text-muted-foreground">{contactSync.unmatched.length} à inviter</span>
                    </div>
                    {contactSync.matched.length > 0 && (
                      <div className="divide-y divide-border/20 border-t border-border/20">
                        {contactSync.matched.map(contact => (
                          <div key={contact.user_id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                            <Link to={`/profile/${contact.user_id}`} className="flex-shrink-0">
                              <UserAvatar src={contact.avatar_url} alt={contact.name} size="md" />
                            </Link>
                            <Link to={`/profile/${contact.user_id}`} className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">{contact.name}</p>
                              <p className="text-[11px] text-muted-foreground truncate">{contact.contact_name}</p>
                            </Link>
                            {contact.is_friend ? (
                              <span className="text-xs text-muted-foreground">✓ Ami</span>
                            ) : (
                              <Button
                                size="sm"
                                className="rounded-xl h-8 text-xs gap-1.5"
                                onClick={() => sendRequest.mutate(contact.user_id)}
                                disabled={sendRequest.isPending}
                              >
                                <UserPlus className="w-3.5 h-3.5" />
                                Ajouter
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <p className="text-xs text-muted-foreground/60">
                  🔒 Vos contacts ne sont pas stockés sur nos serveurs
                </p>
              </div>
            ) : (
              /* Web: Google / Outlook / manual import */
              <div className="flex flex-col p-6 gap-5">
                <h3 className="font-semibold text-lg text-center">Retrouver vos amis</h3>
                <p className="text-sm text-muted-foreground text-center max-w-sm mx-auto">
                  Connectez-vous à votre compte Google ou Outlook pour retrouver vos contacts déjà inscrits sur Forsure
                </p>

                {/* Google import */}
                <div className="flex flex-col gap-3">
                  <Button
                    onClick={() => oauthImport.importGoogleContacts(GOOGLE_CLIENT_ID)}
                    disabled={oauthImport.loading || !GOOGLE_CLIENT_ID}
                    className="gap-2 w-full h-12 rounded-xl"
                    variant="outline"
                  >
                    {oauthImport.loading ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                    )}
                    {oauthImport.loading ? 'Importation...' : 'Importer depuis Google'}
                  </Button>

                  {/* Microsoft/Outlook import */}
                  <Button
                    onClick={() => toast({ title: 'Bientôt disponible', description: 'L\'import Outlook sera disponible prochainement' })}
                    disabled={oauthImport.loading}
                    className="gap-2 w-full h-12 rounded-xl"
                    variant="outline"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#0078D4" d="M24 7.387v10.478c0 .23-.08.424-.238.58a.788.788 0 0 1-.581.238h-8.97V6.569h8.97c.23 0 .424.079.58.237A.788.788 0 0 1 24 7.387zM13.401 2.773l-8.15 1.46a.72.72 0 0 0-.601.71v14.114c0 .35.22.644.6.71l8.15 1.46a.72.72 0 0 0 .85-.71V3.483a.72.72 0 0 0-.85-.71zM9.6 16.247c-2.485 0-4.5-1.903-4.5-4.247s2.015-4.247 4.5-4.247S14.1 9.656 14.1 12s-2.015 4.247-4.5 4.247zm0-6.694c-1.38 0-2.5 1.097-2.5 2.447s1.12 2.447 2.5 2.447 2.5-1.097 2.5-2.447-1.12-2.447-2.5-2.447z"/>
                    </svg>
                    Importer depuis Outlook
                  </Button>
                </div>

                {/* Results from OAuth import */}
                {oauthImport.imported && (
                  <div className="space-y-3">
                    <div className="flex justify-center gap-4 text-sm">
                      <span className="text-primary font-medium">{oauthImport.matches.length} trouvé(s)</span>
                      {oauthImport.stats && (
                        <span className="text-muted-foreground">{oauthImport.stats.total} contacts analysés</span>
                      )}
                    </div>
                    {oauthImport.matches.length > 0 && (
                      <div className="divide-y divide-border/20 rounded-xl border border-border/30 overflow-hidden">
                        {oauthImport.matches.map(contact => (
                          <div key={contact.user_id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                            <Link to={`/profile/${contact.user_id}`} className="flex-shrink-0">
                              <UserAvatar src={contact.avatar_url} alt={contact.name} size="md" />
                            </Link>
                            <Link to={`/profile/${contact.user_id}`} className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">{contact.name}</p>
                              <p className="text-[11px] text-muted-foreground truncate">{contact.contact_name}</p>
                            </Link>
                            {contact.is_friend ? (
                              <span className="text-xs text-muted-foreground">✓ Ami</span>
                            ) : (
                              <Button
                                size="sm"
                                className="rounded-xl h-8 text-xs gap-1.5"
                                onClick={() => sendRequest.mutate(contact.user_id)}
                                disabled={sendRequest.isPending}
                              >
                                <UserPlus className="w-3.5 h-3.5" />
                                Ajouter
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Separator */}
                <div className="relative flex items-center gap-2">
                  <div className="flex-1 border-t border-border" />
                  <span className="text-xs text-muted-foreground">ou recherche manuelle</span>
                  <div className="flex-1 border-t border-border" />
                </div>

                {/* Fallback: manual search via InviteContacts */}
                <InviteContacts />

                <p className="text-xs text-muted-foreground/60 text-center">
                  🔒 Vos contacts ne sont pas stockés sur nos serveurs
                </p>
              </div>
            )}
          </div>
        </TabsContent>


        <TabsContent value="friends" className="mt-4 space-y-4">
          {/* Search */}
          {(data?.friends.length ?? 0) > 5 && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher un ami..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9 rounded-xl h-10 bg-secondary/30 border-border/30"
              />
            </div>
          )}

          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {isLoading ? (
              <LoadingSkeleton />
            ) : filteredFriends.length === 0 ? (
              <EmptyState 
                icon={<Users className="w-10 h-10 text-muted-foreground/40" />}
                message={searchQuery ? 'Aucun résultat' : 'Aucun ami pour le moment'} 
                sub={!searchQuery ? 'Découvre des personnes à ajouter !' : undefined}
              />
            ) : (
              filteredFriends.map(friendship => (
                <div key={friendship.id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-shrink-0">
                    <UserAvatar src={friendship.profile.avatar_url} alt={friendship.profile.name} size="md" />
                  </Link>
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{friendship.profile.name}</p>
                  </Link>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10"
                      onClick={() => handleMessage(friendship.profile.user_id)}
                    >
                      <MessageCircle className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleRemove(friendship.id)}
                    >
                      <UserX className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Suggestions */}
          <FriendSuggestions />
        </TabsContent>

        {/* Requests Tab */}
        <TabsContent value="requests" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {isLoading ? (
              <LoadingSkeleton />
            ) : data?.requests.length === 0 ? (
              <EmptyState 
                icon={<UserCheck className="w-10 h-10 text-muted-foreground/40" />}
                message="Aucune demande d'ami" 
              />
            ) : (
              data?.requests.map(friendship => (
                <div key={friendship.id} className="p-3">
                  <div className="flex items-center gap-3">
                    <Link to={`/profile/${friendship.profile.user_id}`} className="flex-shrink-0">
                      <UserAvatar src={friendship.profile.avatar_url} alt={friendship.profile.name} size="md" />
                    </Link>
                    <div className="flex-1 min-w-0">
                      <Link to={`/profile/${friendship.profile.user_id}`}>
                        <p className="font-medium text-sm truncate">{friendship.profile.name}</p>
                      </Link>
                      <p className="text-[11px] text-muted-foreground">souhaite être votre ami</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2.5 ml-[52px]">
                    <Button
                      size="sm"
                      onClick={() => handleAccept(friendship.id)}
                      disabled={respondToRequest.isPending}
                      className="flex-1 rounded-xl h-9 text-xs active:scale-95 transition-all"
                    >
                      Accepter
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReject(friendship.id)}
                      disabled={respondToRequest.isPending}
                      className="flex-1 rounded-xl h-9 text-xs"
                    >
                      Refuser
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {/* Pending Tab */}
        <TabsContent value="pending" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden divide-y divide-border/20">
            {isLoading ? (
              <LoadingSkeleton />
            ) : data?.pending.length === 0 ? (
              <EmptyState 
                icon={<Clock className="w-10 h-10 text-muted-foreground/40" />}
                message="Aucune demande envoyée" 
              />
            ) : (
              data?.pending.map(friendship => (
                <div key={friendship.id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-shrink-0">
                    <UserAvatar src={friendship.profile.avatar_url} alt={friendship.profile.name} size="md" />
                  </Link>
                  <Link to={`/profile/${friendship.profile.user_id}`} className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{friendship.profile.name}</p>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(friendship.id)}
                    className="text-xs text-muted-foreground hover:text-destructive rounded-xl gap-1.5"
                  >
                    <UserX className="w-3.5 h-3.5" />
                    Annuler
                  </Button>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {/* Invite Tab */}
        <TabsContent value="invite" className="mt-4">
          <div className="rounded-2xl border border-border/30 bg-card overflow-hidden min-h-[300px]">
            <InviteContacts />
          </div>
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function LoadingSkeleton() {
  return (
    <div className="p-3 space-y-3">
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="flex items-center gap-3 animate-pulse">
          <div className="w-10 h-10 rounded-full bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-28 bg-muted rounded-lg" />
            <div className="h-2.5 w-20 bg-muted/60 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, message, sub }: { icon: React.ReactNode; message: string; sub?: string }) {
  return (
    <div className="p-10 text-center">
      <div className="mx-auto mb-3">{icon}</div>
      <p className="text-sm font-medium text-muted-foreground">{message}</p>
      {sub && <p className="text-xs text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}
