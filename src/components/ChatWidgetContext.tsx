import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface ChatWidgetState {
  isOpen: boolean;
  conversationId: string | null;
  isMinimized: boolean;
}

interface ChatWidgetContextType {
  state: ChatWidgetState;
  openChat: (conversationId?: string) => void;
  closeChat: () => void;
  minimizeChat: () => void;
  restoreChat: () => void;
  openConversation: (conversationId: string) => void;
  goBack: () => void;
}

const ChatWidgetContext = createContext<ChatWidgetContextType | undefined>(undefined);

export function ChatWidgetProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatWidgetState>({
    isOpen: false,
    conversationId: null,
    isMinimized: false,
  });

  const openChat = useCallback((conversationId?: string) => {
    setState({ isOpen: true, conversationId: conversationId || null, isMinimized: false });
  }, []);

  const closeChat = useCallback(() => {
    setState({ isOpen: false, conversationId: null, isMinimized: false });
  }, []);

  const minimizeChat = useCallback(() => {
    setState(prev => ({ ...prev, isMinimized: true }));
  }, []);

  const restoreChat = useCallback(() => {
    setState(prev => ({ ...prev, isMinimized: false }));
  }, []);

  const openConversation = useCallback((conversationId: string) => {
    setState({ isOpen: true, conversationId, isMinimized: false });
  }, []);

  const goBack = useCallback(() => {
    setState(prev => ({ ...prev, conversationId: null }));
  }, []);

  return (
    <ChatWidgetContext.Provider value={{ state, openChat, closeChat, minimizeChat, restoreChat, openConversation, goBack }}>
      {children}
    </ChatWidgetContext.Provider>
  );
}

export function useChatWidget() {
  const context = useContext(ChatWidgetContext);
  if (!context) throw new Error('useChatWidget must be used within ChatWidgetProvider');
  return context;
}
