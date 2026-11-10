import { createContext, useContext, useState, ReactNode, useCallback, useRef, useEffect } from 'react';
import { IS_MESSENGER_APP } from '@/lib/applicationVariant';

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
  pendingCall: ZeusCallRequest | null;
  requestCall: (request: Omit<ZeusCallRequest,'id'>) => Promise<string>;
  settleCall: (id:string, error?:string) => void;
  state: ChatWidgetState;
  openChat: (conversationId?: string) => void;
  closeChat: () => void;
  minimizeChat: () => void;
  restoreChat: () => void;
  openConversation: (conversationId: string) => void;
  openNegotiation: (product: NegotiationProduct, conversationId: string) => void;
  goBack: () => void;
}

export interface ZeusCallRequest { id:string; actorId:string; recipientId:string; conversationId:string; type:'audio'|'video'; }

const ChatWidgetContext = createContext<ChatWidgetContextType | undefined>(undefined);

export function ChatWidgetProvider({ children }: { children: ReactNode }) {
  const [pendingCall,setPendingCall]=useState<ZeusCallRequest|null>(null);
  const callReceipt=useRef<{id:string;resolve:(message:string)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|null>(null);
  const settleCall=useCallback((id:string,error?:string)=>{
    const pending=callReceipt.current;if(!pending||pending.id!==id)return;
    clearTimeout(pending.timer);callReceipt.current=null;setPendingCall(null);
    if(error)pending.reject(new Error(error));else pending.resolve('L’appel a été lancé.');
  },[]);
  const requestCall=useCallback((request:Omit<ZeusCallRequest,'id'>):Promise<string>=>{
    if(callReceipt.current)return Promise.reject(new Error('Un appel est déjà en cours de lancement.'));
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>settleCall(id,'Le lancement de l’appel n’a pas été confirmé. Vérifiez la fenêtre d’appel avant de réessayer.'),60_000);
      callReceipt.current={id,resolve,reject,timer};
      setState({isOpen:true,conversationId:request.conversationId,isMinimized:false,negotiationProduct:null});
      setPendingCall({...request,id});
    });
  },[settleCall]);
  useEffect(()=>()=>{
    const pending=callReceipt.current;if(!pending)return;
    clearTimeout(pending.timer);pending.reject(new Error('Le lancement de l’appel a été interrompu.'));callReceipt.current=null;
  },[]);
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
    if(callReceipt.current)settleCall(callReceipt.current.id,'Le lancement de l’appel est annulé.');
    setState({ isOpen: IS_MESSENGER_APP, conversationId: null, isMinimized: false, negotiationProduct: null });
  }, [settleCall]);

  const minimizeChat = useCallback(() => {
    setState(prev => ({ ...prev, isMinimized: !IS_MESSENGER_APP }));
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
    <ChatWidgetContext.Provider value={{ state, openChat, closeChat, minimizeChat, restoreChat, openConversation, openNegotiation, goBack, pendingCall, requestCall, settleCall }}>
      {children}
    </ChatWidgetContext.Provider>
  );
}

export function useChatWidget() {
  const context = useContext(ChatWidgetContext);
  if (!context) throw new Error('useChatWidget must be used within ChatWidgetProvider');
  return context;
}
