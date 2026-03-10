import { useParams } from 'react-router-dom';
import { ChatView } from '@/components/messages/ChatView';
import { ConversationList } from '@/components/messages/ConversationList';

export default function Messages() {
  const { conversationId } = useParams<{ conversationId?: string }>();

  if (conversationId) {
    return <ChatView conversationId={conversationId} />;
  }

  return <ConversationList />;
}
