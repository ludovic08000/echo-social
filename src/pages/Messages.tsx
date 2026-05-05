import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useChatWidget } from '@/components/ChatWidgetContext';

/**
 * Legacy Messages page intentionally disabled.
 *
 * ChatWidget is now the single messaging runtime. This prevents duplicate
 * realtime subscriptions, duplicate decrypt attempts, and X3DH/ratchet conflicts.
 */
export default function Messages() {
  const { conversationId } = useParams();
  const { openChat } = useChatWidget();

  useEffect(() => {
    openChat(conversationId || undefined);
  }, [conversationId, openChat]);

  return <Navigate to="/feed" replace />;
}
