import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

export interface NegotiationProduct {
  id: string;
  title: string;
  price: number;
  thumbnail_url?: string;
  seller_profiles?: { id: string; store_name: string; user_id?: string; store_logo_url?: string };
}

interface ChatWidgetState {
  isOpen: boolean;
  conversationId: string | null;
  isMinimized: boolean;
  negotiationProduct: NegotiationProduct | null;
}

interface ChatWidgetContextType {
  state: ChatWidgetState;
  openChat: (conversationId?: string) => void;
  closeChat: () => void;
  minimizeChat: () => void;
  restoreChat: () => void;
  openConversation: (conversationId: string) => void;
  openNegotiation: (product: NegotiationProduct, conversationId: string) => void;
  goBack: () => void;
}

const ChatWidgetContext = createContext<ChatWidgetContextType | undefined>(undefined);

export function ChatWidgetProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatWidgetState>({
    isOpen: false,
    conversationId: null,
    isMinimized: false,
    negotiationProduct: null,
  });

  const openChat = useCallback((conversationId?: string) => {
    setState({ isOpen: true, conversationId: conversationId || null, isMinimized: false, negotiationProduct: null });
  }, []);

  const closeChat = useCallback(() => {
    setState({ isOpen: false, conversationId: null, isMinimized: false, negotiationProduct: null });
  }, []);

  const minimizeChat = useCallback(() => {
    setState(prev => ({ ...prev, isMinimized: true }));
  }, []);

  const restoreChat = useCallback(() => {
    setState(prev => ({ ...prev, isMinimized: false }));
  }, []);

  const openConversation = useCallback((conversationId: string) => {
    setState(prev => ({ isOpen: true, conversationId, isMinimized: false, negotiationProduct: prev.negotiationProduct }));
  }, []);

  const openNegotiation = useCallback((product: NegotiationProduct, conversationId: string) => {
    setState({ isOpen: true, conversationId, isMinimized: false, negotiationProduct: product });
  }, []);

  const goBack = useCallback(() => {
    setState(prev => ({ ...prev, conversationId: null }));
  }, []);

  return (
    <ChatWidgetContext.Provider value={{ state, openChat, closeChat, minimizeChat, restoreChat, openConversation, openNegotiation, goBack }}>
      {children}
    </ChatWidgetContext.Provider>
  );
}

export function useChatWidget() {
  const context = useContext(ChatWidgetContext);
  if (!context) throw new Error('useChatWidget must be used within ChatWidgetProvider');
  return context;
}
