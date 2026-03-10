import { useState } from 'react';
import { UserPlus, UserCheck, UserX, Clock, MessageCircle, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useFriendshipStatus, useSendFriendRequest, useRespondToFriendRequest, useRemoveFriend } from '@/hooks/useFriendships';
import { useCreateConversation } from '@/hooks/useMessages';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface FriendshipButtonProps {
  userId: string;
  showMessage?: boolean;
  size?: 'sm' | 'default';
}

export function FriendshipButton({ userId, showMessage = true, size = 'sm' }: FriendshipButtonProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: friendship, isLoading } = useFriendshipStatus(userId);
  const sendRequest = useSendFriendRequest();
  const respondToRequest = useRespondToFriendRequest();
  const removeFriend = useRemoveFriend();
  const createConversation = useCreateConversation();
  const [justSent, setJustSent] = useState(false);

  if (!user || user.id === userId) return null;

  const handleSendRequest = () => {
    sendRequest.mutate(userId, {
      onSuccess: () => {
        setJustSent(true);
        toast({ title: '✅ Demande envoyée !' });
      },
      onError: (err: any) => toast({ title: 'Erreur', description: err.message, variant: 'destructive' }),
    });
  };

  const handleAccept = () => {
    if (friendship) {
      respondToRequest.mutate(
        { friendshipId: friendship.id, accept: true },
        { onSuccess: () => toast({ title: '🎉 Ami ajouté !' }) }
      );
    }
  };

  const handleReject = () => {
    if (friendship) {
      respondToRequest.mutate(
        { friendshipId: friendship.id, accept: false },
      );
    }
  };

  const handleRemove = () => {
    if (friendship) {
      removeFriend.mutate(friendship.id);
    }
  };

  const handleMessage = async () => {
    const conv = await createConversation.mutateAsync(userId);
    navigate(`/messages/${conv.id}`);
  };

  if (isLoading) {
    return <Button variant="outline" size={size} disabled className="rounded-xl"><span className="w-16 h-4 skeleton rounded" /></Button>;
  }

  // No friendship yet — Add button
  if (!friendship && !justSent) {
    return (
      <Button 
        size={size}
        onClick={handleSendRequest}
        disabled={sendRequest.isPending}
        className="gap-2 rounded-xl bg-primary hover:bg-primary/90 transition-all active:scale-95"
      >
        <UserPlus className="w-4 h-4" />
        Ajouter
      </Button>
    );
  }

  // Just sent (optimistic)
  if (justSent && !friendship) {
    return (
      <Button variant="outline" size={size} disabled className="gap-2 rounded-xl text-muted-foreground">
        <Clock className="w-4 h-4" />
        Envoyée
      </Button>
    );
  }

  // Pending — I sent the request
  if (friendship?.status === 'pending') {
    const isRequester = friendship.requester_id === user.id;
    
    if (isRequester) {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size={size} className="gap-2 rounded-xl">
              <Clock className="w-4 h-4 text-muted-foreground" />
              En attente
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
            <DropdownMenuItem onClick={handleRemove} className="text-destructive focus:text-destructive gap-2 rounded-lg">
              <UserX className="w-4 h-4" />
              Annuler la demande
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    // Someone sent me a request
    return (
      <div className="flex gap-1.5">
        <Button 
          size={size}
          onClick={handleAccept}
          disabled={respondToRequest.isPending}
          className="gap-1.5 rounded-xl active:scale-95 transition-all"
        >
          <UserCheck className="w-4 h-4" />
          Accepter
        </Button>
        <Button 
          variant="outline" 
          size={size}
          onClick={handleReject}
          disabled={respondToRequest.isPending}
          className="rounded-xl"
        >
          <UserX className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  // Friends
  if (friendship?.status === 'accepted') {
    return (
      <div className="flex gap-1.5">
        {showMessage && (
          <Button 
            size={size}
            onClick={handleMessage}
            disabled={createConversation.isPending}
            className="gap-2 rounded-xl active:scale-95 transition-all"
          >
            <MessageCircle className="w-4 h-4" />
            Message
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size={size} className="gap-1.5 rounded-xl">
              <UserCheck className="w-4 h-4 text-primary" />
              Amis
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
            <DropdownMenuItem onClick={handleMessage} className="gap-2 rounded-lg">
              <MessageCircle className="w-4 h-4" />
              Envoyer un message
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleRemove} className="text-destructive focus:text-destructive gap-2 rounded-lg">
              <UserX className="w-4 h-4" />
              Retirer des amis
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return null;
}
