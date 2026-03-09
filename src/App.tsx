import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ParentalGateProvider } from "@/components/ParentalGate";
import { I18nProvider } from "@/lib/i18n";
import { ChatWidgetProvider, useChatWidget } from "@/components/ChatWidgetContext";
import { ChatWidget } from "@/components/ChatWidget";
import { ProtectedRoute, PublicOnlyRoute } from "@/components/ProtectedRoute";
import { useSettingsInit } from "@/hooks/useSettingsInit";
import { useIncomingCall, endActiveCall } from "@/hooks/useIncomingCall";
import { IncomingCallOverlay } from "@/components/IncomingCallOverlay";
import { useCall } from "@/hooks/useCall";
import { CallOverlay } from "@/components/CallOverlay";
import { useCallback, useRef } from "react";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Feed from "./pages/Feed";
import PostDetail from "./pages/PostDetail";
import CreatePostPage from "./pages/CreatePostPage";
import Profile from "./pages/Profile";
import Search from "./pages/Search";
import Notifications from "./pages/Notifications";
import Settings from "./pages/Settings";
import Messages from "./pages/Messages";
import Friends from "./pages/Friends";
import Groups from "./pages/Groups";
import GroupDetail from "./pages/GroupDetail";
import Pages from "./pages/Pages";
import PageDetail from "./pages/PageDetail";
import Videos from "./pages/Videos";
import Lives from "./pages/Lives";
import LiveWatch from "./pages/LiveWatch";
import Journal from "./pages/Journal";
import Challenges from "./pages/Challenges";
import Games from "./pages/Games";
import FriendMatch from "./pages/FriendMatch";
import Channels from "./pages/Channels";
import Marketplace from "./pages/Marketplace";
import ProductDetailPage from "./pages/ProductDetail";
import LegalTerms from "./pages/LegalTerms";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import AIEngine from "./pages/AIEngine";
import AdsManager from "./pages/AdsManager";
import AIAgents from "./pages/AIAgents";
import Admin from "./pages/Admin";
import CreatorUpgrade from "./pages/CreatorUpgrade";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

/** Global incoming call listener — renders the ringing UI + handles accept */
function IncomingCallHandler() {
  const { user } = useAuth();
  const { incomingCall, acceptCall, declineCall } = useIncomingCall();
  const { openChat } = useChatWidget();

  const call = useCall({
    onCallEnded: useCallback(() => {}, []),
  });

  const handleAccept = useCallback(async () => {
    const accepted = await acceptCall();
    if (!accepted) return;

    // Open the chat with the caller
    openChat(accepted.conversation_id);

    // Start the call (join the LiveKit room)
    call.startCall(accepted.conversation_id, accepted.call_type);
  }, [acceptCall, openChat, call]);

  if (!user) return null;

  return (
    <>
      {incomingCall && (
        <IncomingCallOverlay
          call={incomingCall}
          onAccept={handleAccept}
          onDecline={declineCall}
        />
      )}
      {call.callState !== 'idle' && (
        <CallOverlay
          callState={call.callState}
          callType={call.callType}
          isMuted={call.isMuted}
          isCameraOff={call.isCameraOff}
          duration={call.duration}
          participantName={incomingCall?.caller_name || 'Appelant'}
          participantAvatar={incomingCall?.caller_avatar}
          localVideoRef={call.localVideoRef}
          remoteVideoRef={call.remoteVideoRef}
          onEndCall={call.endCall}
          onToggleMute={call.toggleMute}
          onToggleCamera={call.toggleCamera}
          onSwitchToVideo={call.switchToVideo}
          onSwitchCamera={call.switchCamera}
        />
      )}
    </>
  );
}

function AppContent() {
  useSettingsInit();
  return (
      <AuthProvider>
        <ParentalGateProvider>
        <ChatWidgetProvider>
          <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <IncomingCallHandler />
            <Routes>
              {/* Public routes */}
              <Route path="/" element={<PublicOnlyRoute><Landing /></PublicOnlyRoute>} />
              <Route path="/login" element={<PublicOnlyRoute><Login /></PublicOnlyRoute>} />
              <Route path="/signup" element={<PublicOnlyRoute><Signup /></PublicOnlyRoute>} />
              <Route path="/legal/terms" element={<LegalTerms />} />
              <Route path="/legal/privacy" element={<PrivacyPolicy />} />
              
              {/* Protected routes */}
              <Route path="/feed" element={<ProtectedRoute><Feed /></ProtectedRoute>} />
              <Route path="/post/:id" element={<ProtectedRoute><PostDetail /></ProtectedRoute>} />
              <Route path="/create" element={<ProtectedRoute><CreatePostPage /></ProtectedRoute>} />
              <Route path="/profile/:id" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
              <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
              <Route path="/search" element={<ProtectedRoute><Search /></ProtectedRoute>} />
              <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
              <Route path="/messages" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
              <Route path="/messages/:conversationId" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
              <Route path="/friends" element={<ProtectedRoute><Friends /></ProtectedRoute>} />
              <Route path="/groups" element={<ProtectedRoute><Groups /></ProtectedRoute>} />
              <Route path="/groups/:id" element={<ProtectedRoute><GroupDetail /></ProtectedRoute>} />
              <Route path="/pages" element={<ProtectedRoute><Pages /></ProtectedRoute>} />
              <Route path="/pages/:id" element={<ProtectedRoute><PageDetail /></ProtectedRoute>} />
              <Route path="/videos" element={<ProtectedRoute><Videos /></ProtectedRoute>} />
              <Route path="/lives" element={<ProtectedRoute><Lives /></ProtectedRoute>} />
              <Route path="/live/:id" element={<ProtectedRoute><LiveWatch /></ProtectedRoute>} />
              <Route path="/journal" element={<ProtectedRoute><Journal /></ProtectedRoute>} />
              <Route path="/challenges" element={<ProtectedRoute><Challenges /></ProtectedRoute>} />
              <Route path="/games" element={<ProtectedRoute><Games /></ProtectedRoute>} />
              <Route path="/friend-match" element={<ProtectedRoute><FriendMatch /></ProtectedRoute>} />
              <Route path="/channels" element={<ProtectedRoute><Channels /></ProtectedRoute>} />
              <Route path="/marketplace" element={<ProtectedRoute><Marketplace /></ProtectedRoute>} />
              <Route path="/marketplace/product/:id" element={<ProtectedRoute><ProductDetailPage /></ProtectedRoute>} />
              <Route path="/ai-engine" element={<ProtectedRoute><AIEngine /></ProtectedRoute>} />
              <Route path="/ads" element={<ProtectedRoute><AdsManager /></ProtectedRoute>} />
              <Route path="/ai-agents" element={<ProtectedRoute><AIAgents /></ProtectedRoute>} />
              <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
              <Route path="/creator" element={<ProtectedRoute><CreatorUpgrade /></ProtectedRoute>} />
              
              {/* 404 */}
              <Route path="*" element={<NotFound />} />
            </Routes>
            <ChatWidget />
          </BrowserRouter>
        </TooltipProvider>
      </ChatWidgetProvider>
        </ParentalGateProvider>
    </AuthProvider>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  </QueryClientProvider>
);

export default App;
