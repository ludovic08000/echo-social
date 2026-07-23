import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ParentalGateProvider } from "@/components/ParentalGate";
import { I18nProvider } from "@/lib/i18n";
import { ChatWidgetProvider, useChatWidget } from "@/components/ChatWidgetContext";
import { ChatWidget } from "@/components/ChatWidget";
import { ProtectedRoute, PublicOnlyRoute } from "@/components/ProtectedRoute";
import { RecoveryFlowGuard } from "@/components/RecoveryFlowGuard";
import { SafetyNumberRevalidationBanner } from "@/components/messages/SafetyNumberRevalidationBanner";
import { CookieConsentBanner } from "@/components/CookieConsentBanner";
import DevicePrimaryRepairDialog from "@/components/DevicePrimaryRepairDialog";
import { useSettingsInit } from "@/hooks/useSettingsInit";
import { useVersionWatcher } from "@/hooks/useVersionWatcher";
import { useIncomingCall, endActiveCall } from "@/hooks/useIncomingCall";
import { IncomingCallOverlay } from "@/components/IncomingCallOverlay";
import { useCall } from "@/hooks/useCall";
import { CallOverlay } from "@/components/CallOverlay";
import { Suspense, lazy, useCallback, useEffect, useRef } from "react";
import { useAccountKeySync } from "@/hooks/useAccountKeySync";
import { useCryptoMaintenance } from "@/hooks/useCryptoMaintenance";
import { useDeviceRegistration } from "@/hooks/useDeviceRegistration";
import { startRealtimeKeySync } from "@/lib/messaging/realtimeKeySync";
import { toast } from "sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UXModeContext, useUXModeProvider } from "@/hooks/useUXMode";
import { PushAutoSubscribe } from "@/components/push/PushAutoSubscribe";
import { E2EERestorePromptDialog } from "@/components/messages/E2EERestorePromptDialog";
import { ContactVerificationDialog } from "@/components/messages/ContactVerificationDialog";
import { E2EEDebugPanel } from "@/components/debug/E2EEDebugPanel";

import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Feed from "./pages/Feed";
import Profile from "./pages/Profile";
import NotFound from "./pages/NotFound";

const isChunkLoadError = (e: unknown): boolean => {
  const msg = (e as Error)?.message || '';
  return /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed|error loading dynamically imported module/i.test(msg);
};

if (typeof window !== 'undefined') {
  setTimeout(() => {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('r-')) sessionStorage.removeItem(k);
      }
    } catch {}
  }, 5000);
}

const lazyWithOneRetry = <TModule extends { default: React.ComponentType<any> }>(
  importer: () => Promise<TModule>,
  retryKey: string
) => lazy(async () => {
  try {
    const mod = await importer();
    sessionStorage.removeItem(retryKey);
    return mod;
  } catch (e1) {
    if (!isChunkLoadError(e1)) throw e1;
    const lastRetry = Number(sessionStorage.getItem(retryKey) || '0');
    const canRetry = !lastRetry || Date.now() - lastRetry > 8000;
    if (canRetry) {
      sessionStorage.setItem(retryKey, String(Date.now()));
      window.location.reload();
      return new Promise<TModule>(() => {});
    }
    throw e1;
  }
});

const PostDetail = lazyWithOneRetry(() => import("./pages/PostDetail"), 'r-post');
const CreatePostPage = lazyWithOneRetry(() => import("./pages/CreatePostPage"), 'r-create');
const Search = lazyWithOneRetry(() => import("./pages/Search"), 'r-search');
const Notifications = lazyWithOneRetry(() => import("./pages/Notifications"), 'r-notifs');
const Settings = lazyWithOneRetry(() => import("./pages/Settings"), 'r-settings');
const SecurityDeviceVerify = lazyWithOneRetry(() => import("./pages/SecurityDeviceVerify"), 'r-secdev');
const Messages = lazyWithOneRetry(() => import("./pages/Messages"), 'r-messages');
const Friends = lazyWithOneRetry(() => import("./pages/Friends"), 'r-friends');
const Groups = lazyWithOneRetry(() => import("./pages/Groups"), 'r-groups');
const GroupDetail = lazyWithOneRetry(() => import("./pages/GroupDetail"), 'r-groupd');
const Pages = lazyWithOneRetry(() => import("./pages/Pages"), 'r-pages');
const PageDetail = lazyWithOneRetry(() => import("./pages/PageDetail"), 'r-paged');
const Videos = lazyWithOneRetry(() => import("./pages/Videos"), 'r-videos');
const Lives = lazyWithOneRetry(() => import("./pages/Lives"), 'r-lives');
const LiveWatch = lazyWithOneRetry(() => import("./pages/LiveWatch"), 'r-livew');
const LiveScreen = lazyWithOneRetry(() => import("./pages/LiveScreen"), 'r-lives2');
const Journal = lazyWithOneRetry(() => import("./pages/Journal"), 'r-journal');
const Channels = lazyWithOneRetry(() => import("./pages/Channels"), 'r-channels');
const Marketplace = lazyWithOneRetry(() => import("./pages/Marketplace"), 'r-market');
const ProductDetailPage = lazyWithOneRetry(() => import("./pages/ProductDetail"), 'r-product');
const LegalTerms = lazyWithOneRetry(() => import("./pages/LegalTerms"), 'r-legal');
const PrivacyPolicy = lazyWithOneRetry(() => import("./pages/PrivacyPolicy"), 'r-privacy');
const AIEngine = lazyWithOneRetry(() => import("./pages/AIEngine"), 'r-ai');
const AIAgents = lazyWithOneRetry(() => import("./pages/AIAgents"), 'r-agents');
const Admin = lazyWithOneRetry(() => import("./pages/Admin"), 'r-admin');
const KeyTransparencyAudit = lazyWithOneRetry(() => import("./pages/KeyTransparencyAudit"), 'r-kt-audit');
const CreatorUpgrade = lazyWithOneRetry(() => import("./pages/CreatorUpgrade"), 'r-creator');
const CreatorQuality = lazyWithOneRetry(() => import("./pages/CreatorQuality"), 'r-creator-quality');
const ForgotPassword = lazyWithOneRetry(() => import("./pages/ForgotPassword"), 'r-forgot');
const ResetPassword = lazyWithOneRetry(() => import("./pages/ResetPassword"), 'r-reset');
const Onboarding = lazyWithOneRetry(() => import("./pages/Onboarding"), 'r-onboard');
const AuthConfirmPage = lazyWithOneRetry(() => import("./pages/AuthConfirm"), 'r-authconfirm');
const Unsubscribe = lazyWithOneRetry(() => import("./pages/Unsubscribe"), 'r-unsub');
const SEOLanding = lazyWithOneRetry(() => import("./pages/seo/SEOLanding"), 'r-seo');
const SEOMessaging = lazyWithOneRetry(() => import("./pages/seo/SEOMessaging"), 'r-seo-msg');
const SEOSecurity = lazyWithOneRetry(() => import("./pages/seo/SEOSecurity"), 'r-seo-sec');
const SEOModeration = lazyWithOneRetry(() => import("./pages/seo/SEOModeration"), 'r-seo-mod');
const SEOProtection = lazyWithOneRetry(() => import("./pages/seo/SEOProtection"), 'r-seo-prot');
const SEOFeed = lazyWithOneRetry(() => import("./pages/seo/SEOFeed"), 'r-seo-feed');
const Dashboard = lazyWithOneRetry(() => import("./pages/Dashboard"), 'r-dash');
const AdsManager = lazyWithOneRetry(() => import("./pages/AdsManager"), 'r-ads');

const queryClient = new QueryClient();

function IncomingCallHandler() {
  const { user } = useAuth();
  const { incomingCall, acceptCall, declineCall } = useIncomingCall();
  const { openChat } = useChatWidget();
  const activeIncomingCallIdRef = useRef<string | null>(null);
  const activeIncomingConversationIdRef = useRef<string | null>(null);

  const call = useCall({
    onCallEnded: useCallback(() => {
      if (activeIncomingCallIdRef.current) {
        endActiveCall(activeIncomingCallIdRef.current);
        activeIncomingCallIdRef.current = null;
      }
      activeIncomingConversationIdRef.current = null;
    }, []),
    onCallConnected: useCallback(() => {
      if (activeIncomingConversationIdRef.current) {
        openChat(activeIncomingConversationIdRef.current);
      }
    }, [openChat]),
  });

  const handleAccept = useCallback(async () => {
    try {
      const accepted = await acceptCall();
      if (!accepted) return;
      activeIncomingCallIdRef.current = accepted.id;
      activeIncomingConversationIdRef.current = accepted.conversation_id;
      call.startCall(accepted.conversation_id, accepted.call_type, accepted.decryptedCallKey);
    } catch (err) {
      console.error('[CALL] Failed to accept call:', err);
      toast.error("Impossible d'accepter l'appel — réessayez");
    }
  }, [acceptCall, call]);

  if (!user) return null;

  return (
    <>
      <PushAutoSubscribe />
      {incomingCall && <IncomingCallOverlay call={incomingCall} onAccept={handleAccept} onDecline={declineCall} />}
      {call.callState !== 'idle' && (
        <CallOverlay
          callState={call.callState}
          callType={call.callType}
          isMuted={call.isMuted}
          isCameraOff={call.isCameraOff}
          duration={call.duration}
          participantName={incomingCall?.caller_name || 'Appelant'}
          participantAvatar={incomingCall?.caller_avatar}
          isE2eeActive={call.isE2eeActive}
          connectionQuality={call.connectionQuality}
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

function AccountKeySyncRunner() {
  const { user } = useAuth();
  useAccountKeySync();
  useCryptoMaintenance();
  useDeviceRegistration();


  useEffect(() => {
    if (!user?.id) return;
    const stop = startRealtimeKeySync({ userId: user.id });
    return () => stop();
  }, [user?.id]);


  useEffect(() => {
    const onRestoreNeeded = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      console.warn('[App] device-kx restore deferred:', detail);
    };
    window.addEventListener('forsure:device-kx-restore-required', onRestoreNeeded);
    return () => window.removeEventListener('forsure:device-kx-restore-required', onRestoreNeeded);
  }, []);

  return null;
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

function AppContent() {
  useSettingsInit();
  useVersionWatcher();
  return (
    <AuthProvider>
      <ParentalGateProvider>
        <ChatWidgetProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <RecoveryFlowGuard />
              <AccountKeySyncRunner />
              <SafetyNumberRevalidationBanner />
              <DevicePrimaryRepairDialog />
              <IncomingCallHandler />
              <E2EEDebugPanel />
              <RoutedErrorBoundary>
                <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background"><div className="w-12 h-12 rounded-full bg-pulse-gradient animate-pulse-slow" /></div>}>
                  <Routes>
                    <Route path="/" element={<Navigate to="/feed" replace />} />
                    <Route path="/landing" element={<Landing />} />
                    <Route path="/login" element={<PublicOnlyRoute><Login /></PublicOnlyRoute>} />
                    <Route path="/signup" element={<PublicOnlyRoute><Signup /></PublicOnlyRoute>} />
                    <Route path="/legal" element={<LegalTerms />} />
                    <Route path="/legal/terms" element={<LegalTerms />} />
                    <Route path="/legal/privacy" element={<PrivacyPolicy />} />
                    <Route path="/privacy" element={<PrivacyPolicy />} />
                    <Route path="/a-propos" element={<SEOLanding />} />
                    <Route path="/reseau-social-securise" element={<SEOSecurity />} />
                    <Route path="/messagerie-chiffree" element={<SEOMessaging />} />
                    <Route path="/ia-moderation" element={<SEOModeration />} />
                    <Route path="/protection-donnees" element={<SEOProtection />} />
                    <Route path="/feed-intelligent" element={<SEOFeed />} />
                    <Route path="/fonctionnalites/messagerie-chiffree" element={<SEOMessaging />} />
                    <Route path="/fonctionnalites/securite" element={<SEOSecurity />} />
                    <Route path="/fonctionnalites/moderation-ia" element={<SEOModeration />} />
                    <Route path="/fonctionnalites/protection-utilisateurs" element={<SEOProtection />} />
                    <Route path="/fonctionnalites/feed-intelligent" element={<SEOFeed />} />
                    <Route path="/forgot-password" element={<PublicOnlyRoute><ForgotPassword /></PublicOnlyRoute>} />
                    <Route path="/reset-password" element={<ResetPassword />} />
                    <Route path="/onboarding" element={<Onboarding />} />
                    <Route path="/auth/confirm" element={<Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background"><div className="w-12 h-12 rounded-full bg-pulse-gradient animate-pulse-slow" /></div>}><AuthConfirmPage /></Suspense>} />
                    <Route path="/feed" element={<Feed />} />
                    <Route path="/post/:id" element={<PostDetail />} />
                    <Route path="/profile/:id" element={<Navigate to="/feed" replace />} />
                    <Route path="/search" element={<Search />} />
                    <Route path="/videos" element={<Videos />} />
                    <Route path="/lives" element={<LiveScreen />} />
                    <Route path="/live/:id" element={<LiveWatch />} />
                    <Route path="/marketplace" element={<Marketplace />} />
                    <Route path="/marketplace/product/:id" element={<ProductDetailPage />} />
                    <Route path="/channels" element={<Channels />} />
                    <Route path="/create" element={<ProtectedRoute><CreatePostPage /></ProtectedRoute>} />
                    <Route path="/profile" element={<Navigate to="/feed" replace />} />
                    <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
                    <Route path="/security/device" element={<ProtectedRoute><SecurityDeviceVerify /></ProtectedRoute>} />
                    <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
                    <Route path="/messages" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
                    <Route path="/messages/:conversationId" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
                    <Route path="/friends" element={<ProtectedRoute><Friends /></ProtectedRoute>} />
                    <Route path="/groups" element={<ProtectedRoute><Groups /></ProtectedRoute>} />
                    <Route path="/groups/:id" element={<ProtectedRoute><GroupDetail /></ProtectedRoute>} />
                    <Route path="/pages" element={<ProtectedRoute><Pages /></ProtectedRoute>} />
                    <Route path="/pages/:id" element={<ProtectedRoute><PageDetail /></ProtectedRoute>} />
                    <Route path="/live" element={<ProtectedRoute><LiveScreen /></ProtectedRoute>} />
                    <Route path="/journal" element={<ProtectedRoute><Journal /></ProtectedRoute>} />
                    
                    <Route path="/ai-engine" element={<ProtectedRoute><AIEngine /></ProtectedRoute>} />
                    <Route path="/ads" element={<ProtectedRoute><AdsManager /></ProtectedRoute>} />
                    <Route path="/publicites" element={<ProtectedRoute><AdsManager /></ProtectedRoute>} />
                    <Route path="/ai-agents" element={<ProtectedRoute><AIAgents /></ProtectedRoute>} />
                    <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
                    <Route path="/settings/transparence-cles" element={<ProtectedRoute><KeyTransparencyAudit /></ProtectedRoute>} />
                    <Route path="/creator" element={<ProtectedRoute><CreatorUpgrade /></ProtectedRoute>} />
                    <Route path="/creator/quality" element={<ProtectedRoute><CreatorQuality /></ProtectedRoute>} />
                    <Route path="/quality" element={<ProtectedRoute><CreatorQuality /></ProtectedRoute>} />
                    <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                    <Route path="/unsubscribe" element={<Unsubscribe />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </Suspense>
              </RoutedErrorBoundary>
              <ChatWidget />
              <E2EERestorePromptDialog />
              <ContactVerificationDialog />
              <CookieConsentBanner />
            </BrowserRouter>
          </TooltipProvider>
        </ChatWidgetProvider>
      </ParentalGateProvider>
    </AuthProvider>
  );
}

const App = () => {
  const uxMode = useUXModeProvider();
  return (
    <UXModeContext.Provider value={uxMode}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <AppContent />
        </I18nProvider>
      </QueryClientProvider>
    </UXModeContext.Provider>
  );
};

export default App;
