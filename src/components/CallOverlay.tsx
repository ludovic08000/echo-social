import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { cn } from '@/lib/utils';
import { CallState, CallType, formatCallDuration } from '@/hooks/useCall';
import { RefObject } from 'react';

interface CallOverlayProps {
  callState: CallState;
  callType: CallType;
  isMuted: boolean;
  isCameraOff: boolean;
  duration: number;
  participantName: string;
  participantAvatar?: string | null;
  localVideoRef: RefObject<HTMLDivElement>;
  remoteVideoRef: RefObject<HTMLDivElement>;
  onEndCall: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onSwitchToVideo?: () => void;
}

export function CallOverlay({
  callState,
  callType,
  isMuted,
  isCameraOff,
  duration,
  participantName,
  participantAvatar,
  localVideoRef,
  remoteVideoRef,
  onEndCall,
  onToggleMute,
  onToggleCamera,
  onSwitchToVideo,
}: CallOverlayProps) {
  if (callState === 'idle') return null;

  const isVideo = callType === 'video';
  const isConnecting = callState === 'connecting';

  return (
    <div className="fixed inset-0 z-[100] bg-black flex flex-col">
      {/* Remote video (full screen) */}
      {isVideo && (
        <div
          ref={remoteVideoRef}
          className="absolute inset-0 bg-gradient-to-br from-card/40 via-black to-card/20"
        />
      )}

      {/* Audio call background */}
      {!isVideo && (
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-background to-primary/10" />
      )}

      {/* Top section - participant info */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center">
        {/* Show avatar for audio calls or when connecting */}
        {(!isVideo || isConnecting) && (
          <>
            <div className={cn(
              'relative mb-6',
              isConnecting && 'animate-pulse'
            )}>
              <UserAvatar
                src={participantAvatar}
                alt={participantName}
                size="xl"
              />
              {isConnecting && (
                <div className="absolute inset-0 rounded-full border-4 border-primary/40 animate-ping" />
              )}
            </div>
            <h2 className="text-white text-2xl font-bold mb-2">{participantName}</h2>
            <p className="text-white/60 text-sm">
              {isConnecting
                ? 'Appel en cours…'
                : formatCallDuration(duration)
              }
            </p>
          </>
        )}

        {/* Connected video call - show duration on top */}
        {isVideo && !isConnecting && (
          <div className="absolute top-safe-area-top pt-12 left-0 right-0 flex items-center justify-center">
            <div className="bg-black/40 backdrop-blur-sm rounded-full px-4 py-1.5 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
              <span className="text-white text-sm font-medium">{formatCallDuration(duration)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Local video (pip) - video call only */}
      {isVideo && (
        <div
          ref={localVideoRef}
          className={cn(
            'absolute top-20 right-4 w-28 h-40 rounded-2xl overflow-hidden bg-card/50 border-2 border-white/20 shadow-2xl z-20',
            isCameraOff && 'flex items-center justify-center'
          )}
        >
          {isCameraOff && (
            <VideoOff className="w-8 h-8 text-white/40" />
          )}
        </div>
      )}

      {/* Bottom controls */}
      <div className="relative z-10 pb-safe-area-bottom pb-8">
        <div className="flex items-center justify-center gap-4">
          {/* Mute */}
          <Button
            size="icon"
            variant="secondary"
            onClick={onToggleMute}
            className={cn(
              'w-14 h-14 rounded-full',
              isMuted
                ? 'bg-destructive/80 hover:bg-destructive text-white'
                : 'bg-white/20 hover:bg-white/30 text-white'
            )}
          >
            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </Button>

          {/* Toggle camera (video calls) or switch to video (audio calls) */}
          {isVideo ? (
            <Button
              size="icon"
              variant="secondary"
              onClick={onToggleCamera}
              className={cn(
                'w-14 h-14 rounded-full',
                isCameraOff
                  ? 'bg-destructive/80 hover:bg-destructive text-white'
                  : 'bg-white/20 hover:bg-white/30 text-white'
              )}
            >
              {isCameraOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
            </Button>
          ) : (
            <Button
              size="icon"
              variant="secondary"
              onClick={onSwitchToVideo}
              className="w-14 h-14 rounded-full bg-white/20 hover:bg-white/30 text-white"
            >
              <Video className="w-6 h-6" />
            </Button>
          )}

          {/* End call */}
          <Button
            size="icon"
            onClick={onEndCall}
            className="w-16 h-16 rounded-full bg-destructive hover:bg-destructive/90 text-white shadow-lg shadow-destructive/30"
          >
            <PhoneOff className="w-7 h-7" />
          </Button>
        </div>
      </div>
    </div>
  );
}
