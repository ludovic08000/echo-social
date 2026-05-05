import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useChatWidget } from '@/components/ChatWidgetContext';

export default function Messages() {
  const { conversationId } = useParams();
  const { openChat } = useChatWidget();

  useEffect(() => {
    openChat(conversationId || undefined);
  }, [conversationId, openChat]);

  return <Navigate to="/feed" replace />;
}
