import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ParentalGateProvider } from "@/components/ParentalGate";
import { I18nProvider } from "@/lib/i18n";
import { ChatWidgetProvider, useChatWidget } from "@/components/ChatWidgetContext";
import { CreatorOnlyRoute, ProtectedRoute, PublicOnlyRoute } from "@/components/ProtectedRoute";
import { RecoveryFlowGuard } from "@/components/RecoveryFlowGuard";
import { CookieConsentBanner } from "@/components/CookieConsentBanner";
import { useSettingsInit } from "@/hooks/useSettingsInit";
import { useVersionWatcher } from "@/hooks/useVersionWatcher";
import { useIncomingCall, endActiveCall } from "@/hooks/useIncomingCall";
import { IncomingCallOverlay } from "@/components/IncomingCallOverlay";
import { useCall } from "@/hooks/useCall";
import { CallOverlay } from "@/components/CallOverlay";
import { Suspense, lazy, useCallback, useEffect, useRef } from "react";
import { MotionConfig } from "framer-motion";
import { useAccountKeyWatchdog } from "@/hooks/useAccountKeyWatchdog";
import { useCryptoMaintenance } from "@/hooks/useCryptoMaintenance";
import { useDeviceLifecycle } from "@/hooks/useDeviceLifecycle";
import { useDeviceCopyRetryWorker } from "@/hooks/useDeviceCopyRetryWorker";
import { messagingApi } from "@/lib/api/messagingApi";
import { toast } from "sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { UXModeContext, useUXMode, useUXModeProvider } from "@/hooks/useUXMode";
import { PushAutoSubscribe } from "@/components/push/PushAutoSubscribe";
import { ContactVerificationDialog } from "@/components/messages/ContactVerificationDialog";
import { E2EEDebugPanel } from "@/components/debug/E2EEDebugPanel";
import { callErrorUserMessage } from "@/lib/calls/callDiagnostics";
import { SettingsRuntime } from "@/components/settings/SettingsRuntime";
import { LoginSecurityBoundary } from "@/components/security/LoginSecurityBoundary";
import { LoginApprovalInbox } from "@/components/security/LoginApprovalInbox";
import { LoginSecurityEmailDecisionBridge } from "@/components/security/LoginSecurityEmailDecisionBridge";
import { bindCurrentLoginSessionToApprovedDevice } from "@/lib/security/loginSecurity";

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
    } catch {
      // Session storage cleanup is best-effort in restricted browser modes.
    }
  }, 5000);
}

const lazyWithOneRetry = <TModule extends { default: React.ComponentType<object> }>(
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
const NewsDiscussion = lazyWithOneRetry(() => import("./pages/NewsDiscussion"), 'r-news');
const Landing = lazyWithOneRetry(() => import("./pages/Landing"), 'r-landing');
const Login = lazyWithOneRetry(() => import("./pages/Login"), 'r-login');
const OAuthConsent = lazyWithOneRetry(() => import("./pages/OAuthConsent"), 'r-oauth');
const Signup = lazyWithOneRetry(() => import("./pages/Signup"), 'r-signup');
const Feed = lazyWithOneRetry(() => import("./pages/Feed"), 'r-feed');
const NotFound = lazyWithOneRetry(() => import("./pages/NotFound"), 'r-not-found');
const ChatWidget = lazy(() => import("@/components/ChatWidget").then((module) => ({ default: module.ChatWidget })));
const CreatePostPage = lazyWithOneRetry(() => import("./pages/CreatePostPage"), 'r-create');
const Search = lazyWithOneRetry(() => import("./pages/Search"), 'r-search');
const Notifications = lazyWithOneRetry(() => import("./pages/Notifications"), 'r-notifs');
const Settings = lazyWithOneRetry(() => import("./pages/Settings"), 'r-settings');
const Messages = lazyWithOneRetry(() => import("./pages/Messages"), 'r-messages');
const Friends = lazyWithOneRetry(() => import("./pages/Friends"), 'r-friends');
const Videos = lazyWithOneRetry(() => import("./pages/Videos"), 'r-videos');
const Lives = lazyWithOneRetry(() => import("./pages/Lives"), 'r-lives');
const LiveWatch = lazyWithOneRetry(() => import("./pages/LiveWatch"), 'r-livew');
const LiveScreen = lazyWithOneRetry(() => import("./pages/LiveScreen"), 'r-lives2');
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
        void endActiveCall(activeIncomingCallIdRef.current).catch(() => undefined);
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
      const started = await call.startCall(accepted.id, accepted.call_type, accepted.decryptedCallKey);
      if (!started) {
        await endActiveCall(accepted.id).catch(() => undefined);
        activeIncomingCallIdRef.current = null;
        activeIncomingConversationIdRef.current = null;
      }
    } catch (err) {
      toast.error(callErrorUserMessage(err));
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

/** Runtime E2EE: mounted only when the canonical lifecycle authorizes it. */
function MessagingRuntimeRunner() {
  const { user } = useAuth();
  // Post-runtime uniquement : surveillance/restauration silencieuse, jamais la
  // séquence boot (elle appartient au contrôleur de cycle de vie).
  useAccountKeyWatchdog();
  useCryptoMaintenance();
  useDeviceCopyRetryWorker();

  useEffect(() => {
    if (!user?.id) return;
    return messagingApi.startRuntime(user.id);
  }, [user?.id]);

  return (
    <>
      <IncomingCallHandler />
      <E2EEDebugPanel />
    </>
  );
}

function ApprovedAccountKeySyncRunner() {
  const { user, loginSecurity, refreshLoginSecurity } = useAuth();
  const lifecycle = useDeviceLifecycle();
  const boundSessionDeviceRef = useRef<string | null>(null);

  useEffect(() => {
    const onRestoreNeeded = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      console.warn('[App] device-kx restore deferred:', detail);
    };
    window.addEventListener('forsure:device-kx-restore-required', onRestoreNeeded);
    return () => window.removeEventListener('forsure:device-kx-restore-required', onRestoreNeeded);
  }, []);

  useEffect(() => {
    const record = lifecycle.record;
    const sessionId = loginSecurity.session?.sessionId;
    if (!user?.id || loginSecurity.status !== 'approved' || !sessionId || !record
      || record.approvalStatus !== 'approved' || record.isActive !== true || record.revokedAt
      || loginSecurity.session?.deviceId === record.deviceId) return;

    const bindingKey = `${sessionId}:${record.deviceId}`;
    if (boundSessionDeviceRef.current === bindingKey) return;
    boundSessionDeviceRef.current = bindingKey;

    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await bindCurrentLoginSessionToApprovedDevice(user.id);
          await refreshLoginSecurity();
          return;
        } catch (error) {
          if (attempt === 2) {
            console.warn('[LOGIN_SECURITY] approved device binding deferred', error);
            boundSessionDeviceRef.current = null;
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)));
        }
      }
    })();
  }, [
    lifecycle.record,
    loginSecurity.session?.deviceId,
    loginSecurity.session?.sessionId,
    loginSecurity.status,
    refreshLoginSecurity,
    user?.id,
  ]);

  if (!lifecycle.canRunCryptoRuntime) return null;
  return <MessagingRuntimeRunner />;
}

function AccountKeySyncRunner() {
  const { loginSecurity, cryptoRestoring } = useAuth();
  if (loginSecurity.status !== 'approved' || cryptoRestoring) return null;
  return <ApprovedAccountKeySyncRunner />;
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>;
}

function AppContent() {
  const { mode } = useUXMode();
  const { animationsDisabled } = useSettingsInit(mode);
  useVersionWatcher();
  return (
    <MotionConfig
      reducedMotion={animationsDisabled ? "always" : "user"}
      transition={animationsDisabled ? { duration: 0 } : undefined}
    >
      <AuthProvider>
        <ParentalGateProvider>
          <ChatWidgetProvider>
            <TooltipProvider>
              <Toaster />
              <Sonner />
              <BrowserRouter>
                <LoginSecurityEmailDecisionBridge />
                <LoginSecurityBoundary>
                  <RecoveryFlowGuard />
                  <SettingsRuntime />
                  <AccountKeySyncRunner />
                  <LoginApprovalInbox />
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
                    <Route path="/.lovable/oauth/consent" element={<OAuthConsent />} />
                    <Route path="/auth/confirm" element={<Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-background"><div className="w-12 h-12 rounded-full bg-pulse-gradient animate-pulse-slow" /></div>}><AuthConfirmPage /></Suspense>} />
                    <Route path="/feed" element={<Feed />} />
                    <Route path="/post/:id" element={<PostDetail />} />
                    <Route path="/news/:id" element={<ProtectedRoute><NewsDiscussion /></ProtectedRoute>} />
                    <Route path="/profile/:id" element={<Feed />} />
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
                    <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
                    <Route path="/messages" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
                    <Route path="/messages/:conversationId" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
                    <Route path="/friends" element={<ProtectedRoute><Friends /></ProtectedRoute>} />
                    <Route path="/ai-engine" element={<ProtectedRoute><AIEngine /></ProtectedRoute>} />
                    <Route path="/ads" element={<CreatorOnlyRoute><AdsManager /></CreatorOnlyRoute>} />
                    <Route path="/publicites" element={<CreatorOnlyRoute><AdsManager /></CreatorOnlyRoute>} />
                    <Route path="/ai-agents" element={<CreatorOnlyRoute><AIAgents /></CreatorOnlyRoute>} />
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
                  <ContactVerificationDialog />
                  <CookieConsentBanner />
                </LoginSecurityBoundary>
              </BrowserRouter>
            </TooltipProvider>
          </ChatWidgetProvider>
        </ParentalGateProvider>
      </AuthProvider>
    </MotionConfig>
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
