import { useParams } from 'react-router-dom';
import { ChatView } from '@/components/messages/ChatView';
import { ConversationList } from '@/components/messages/ConversationList';
import { MessagingPinGate } from '@/components/MessagingPinGate';

export default function Messages() {
  const { conversationId } = useParams<{ conversationId?: string }>();

  return (
    <MessagingPinGate>
      {conversationId ? (
        <ChatView conversationId={conversationId} />
      ) : (
        <ConversationList />
      )}
    </MessagingPinGate>
  );
}
