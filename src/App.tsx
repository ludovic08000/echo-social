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
import { Suspense, lazy, useCallback, useRef } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Eager-load critical routes
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Feed from "./pages/Feed";
import NotFound from "./pages/NotFound";

// Lazy-load all secondary routes for smaller initial bundle
const PostDetail = lazy(() => import("./pages/PostDetail"));
const CreatePostPage = lazy(() => import("./pages/CreatePostPage"));
const Profile = lazy(() => import("./pages/Profile"));
const Search = lazy(() => import("./pages/Search"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Settings = lazy(() => import("./pages/Settings"));
const Messages = lazy(() => import("./pages/Messages"));
const Friends = lazy(() => import("./pages/Friends"));
const Groups = lazy(() => import("./pages/Groups"));
const GroupDetail = lazy(() => import("./pages/GroupDetail"));
const Pages = lazy(() => import("./pages/Pages"));
const PageDetail = lazy(() => import("./pages/PageDetail"));
const Videos = lazy(() => import("./pages/Videos"));
const Lives = lazy(() => import("./pages/Lives"));
const LiveWatch = lazy(() => import("./pages/LiveWatch"));
const LiveScreen = lazy(() => import("./pages/LiveScreen"));
const Journal = lazy(() => import("./pages/Journal"));
const Challenges = lazy(() => import("./pages/Challenges"));
const Games = lazy(() => import("./pages/Games"));
const FriendMatch = lazy(() => import("./pages/FriendMatch"));
const Channels = lazy(() => import("./pages/Channels"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const ProductDetailPage = lazy(() => import("./pages/ProductDetail"));
const LegalTerms = lazy(() => import("./pages/LegalTerms"));
const PrivacyPolicy = lazy(() => import("./pages/PrivacyPolicy"));
const AIEngine = lazy(() => import("./pages/AIEngine"));
const AdsManager = lazy(() => import("./pages/AdsManager"));
const AIAgents = lazy(() => import("./pages/AIAgents"));
const Admin = lazy(() => import("./pages/Admin"));
const CreatorUpgrade = lazy(() => import("./pages/CreatorUpgrade"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Onboarding = lazy(() => import("./pages/Onboarding"));

const queryClient = new QueryClient();

/** Global incoming call listener — renders the ringing UI + handles accept */
function IncomingCallHandler() {
  const { user } = useAuth();
  const { incomingCall, acceptCall, declineCall } = useIncomingCall();
  const { openChat } = useChatWidget();

  const activeIncomingCallIdRef = useRef<string | null>(null);

  const call = useCall({
    onCallEnded: useCallback(() => {
      if (activeIncomingCallIdRef.current) {
        endActiveCall(activeIncomingCallIdRef.current);
        activeIncomingCallIdRef.current = null;
      }
    }, []),
  });

  const handleAccept = useCallback(async () => {
    const accepted = await acceptCall();
    if (!accepted) return;

    // Open the chat with the caller
    openChat(accepted.conversation_id);

    activeIncomingCallIdRef.current = accepted.id;

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
            <ErrorBoundary>
            <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background"><div className="w-12 h-12 rounded-full bg-pulse-gradient animate-pulse-slow" /></div>}>
            <Routes>
              {/* Public routes */}
              <Route path="/" element={<PublicOnlyRoute><Landing /></PublicOnlyRoute>} />
              <Route path="/login" element={<PublicOnlyRoute><Login /></PublicOnlyRoute>} />
              <Route path="/signup" element={<PublicOnlyRoute><Signup /></PublicOnlyRoute>} />
              <Route path="/legal" element={<LegalTerms />} />
              <Route path="/legal/terms" element={<LegalTerms />} />
              <Route path="/legal/privacy" element={<PrivacyPolicy />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/forgot-password" element={<PublicOnlyRoute><ForgotPassword /></PublicOnlyRoute>} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
              
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
              <Route path="/live" element={<ProtectedRoute><LiveScreen /></ProtectedRoute>} />
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
            </Suspense>
            </ErrorBoundary>
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
