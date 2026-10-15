/**
 * Bridge page → ChatWidget is the ONLY messaging surface.
 *
 * Anything navigating to /messages or /messages/:id opens the floating
 * ChatWidget and immediately redirects back to /feed. We never mount
 * a second chat runtime, second realtime listener or second decrypt loop.
 */
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useChatWidget } from '@/components/ChatWidgetContext';
import { IS_MESSENGER_APP } from '@/lib/applicationVariant';

export default function Messages() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const { openChat } = useChatWidget();

  useEffect(() => {
    openChat(conversationId);
  }, [conversationId, openChat]);

  // Même runtime de chat, sans monter le feed dans l'application indépendante.
  return IS_MESSENGER_APP ? <main className="min-h-screen bg-background" aria-label="ForSure Messages" /> : <Navigate to="/feed" replace />;
}
