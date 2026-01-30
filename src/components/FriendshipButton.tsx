import { UserPlus, UserCheck, UserX, Clock, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useFriendshipStatus, useSendFriendRequest, useRespondToFriendRequest, useRemoveFriend } from '@/hooks/useFriendships';
import { useCreateConversation } from '@/hooks/useMessages';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';

interface FriendshipButtonProps {
  userId: string;
  showMessage?: boolean;
}

export function FriendshipButton({ userId, showMessage = true }: FriendshipButtonProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: friendship, isLoading } = useFriendshipStatus(userId);
  const sendRequest = useSendFriendRequest();
  const respondToRequest = useRespondToFriendRequest();
  const removeFriend = useRemoveFriend();
  const createConversation = useCreateConversation();

  if (!user || user.id === userId) return null;

  const handleSendRequest = () => {
    sendRequest.mutate(userId, {
      onSuccess: () => toast({ title: 'Demande envoyée !' }),
      onError: () => toast({ title: 'Erreur', variant: 'destructive' }),
    });
  };

  const handleAccept = () => {
    if (friendship) {
      respondToRequest.mutate(
        { friendshipId: friendship.id, accept: true },
        {
          onSuccess: () => toast({ title: 'Ami ajouté !' }),
        }
      );
    }
  };

  const handleReject = () => {
    if (friendship) {
      respondToRequest.mutate(
        { friendshipId: friendship.id, accept: false },
        {
          onSuccess: () => toast({ title: 'Demande refusée' }),
        }
      );
    }
  };

  const handleRemove = () => {
    if (friendship && confirm('Retirer cet ami ?')) {
      removeFriend.mutate(friendship.id);
    }
  };

  const handleMessage = async () => {
    const conv = await createConversation.mutateAsync(userId);
    navigate(`/messages/${conv.id}`);
  };

  if (isLoading) {
    return <Button variant="outline" size="sm" disabled>...</Button>;
  }

  if (!friendship) {
    return (
      <Button 
        variant="default" 
        size="sm" 
        onClick={handleSendRequest}
        disabled={sendRequest.isPending}
        className="gap-2"
      >
        <UserPlus className="w-4 h-4" />
        Ajouter
      </Button>
    );
  }

  if (friendship.status === 'pending') {
    const isRequester = friendship.requester_id === user.id;
    
    if (isRequester) {
      return (
        <Button variant="outline" size="sm" disabled className="gap-2">
          <Clock className="w-4 h-4" />
          En attente
        </Button>
      );
    }

    return (
      <div className="flex gap-2">
        <Button 
          variant="default" 
          size="sm" 
          onClick={handleAccept}
          disabled={respondToRequest.isPending}
        >
          <UserCheck className="w-4 h-4" />
        </Button>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleReject}
          disabled={respondToRequest.isPending}
        >
          <UserX className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  if (friendship.status === 'accepted') {
    return (
      <div className="flex gap-2">
        {showMessage && (
          <Button 
            variant="default" 
            size="sm" 
            onClick={handleMessage}
            disabled={createConversation.isPending}
            className="gap-2"
          >
            <MessageCircle className="w-4 h-4" />
            Message
          </Button>
        )}
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleRemove}
          disabled={removeFriend.isPending}
          className="gap-2"
        >
          <UserCheck className="w-4 h-4" />
          Amis
        </Button>
      </div>
    );
  }

  return null;
}
