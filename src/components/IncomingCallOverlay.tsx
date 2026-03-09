import { Phone, PhoneOff, Video } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import type { IncomingCall } from '@/hooks/useIncomingCall';

interface IncomingCallOverlayProps {
  call: IncomingCall;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingCallOverlay({ call, onAccept, onDecline }: IncomingCallOverlayProps) {
  const isVideo = call.call_type === 'video';

  return (
    <div className="fixed inset-0 z-[110] bg-black/90 flex flex-col items-center justify-center">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-background/10 to-primary/10" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center text-center space-y-6 px-8">
        {/* Pulsing ring */}
        <div className="relative">
          <div className="absolute inset-0 rounded-full border-4 border-primary/30 animate-ping" style={{ animationDuration: '1.5s' }} />
          <div className="absolute -inset-4 rounded-full border-2 border-primary/15 animate-ping" style={{ animationDuration: '2s' }} />
          <UserAvatar
            src={call.caller_avatar}
            alt={call.caller_name || 'Appelant'}
            size="xl"
          />
        </div>

        {/* Caller info */}
        <div className="space-y-2">
          <h2 className="text-white text-2xl font-bold">{call.caller_name || 'Appelant'}</h2>
          <p className="text-white/60 text-sm flex items-center gap-2 justify-center">
            {isVideo ? <Video className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
            {isVideo ? 'Appel vidéo entrant…' : 'Appel audio entrant…'}
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-10 pt-6">
          {/* Decline */}
          <div className="flex flex-col items-center gap-2">
            <Button
              size="icon"
              onClick={onDecline}
              className="w-16 h-16 rounded-full bg-destructive hover:bg-destructive/90 text-white shadow-lg shadow-destructive/30"
            >
              <PhoneOff className="w-7 h-7" />
            </Button>
            <span className="text-white/60 text-xs">Refuser</span>
          </div>

          {/* Accept */}
          <div className="flex flex-col items-center gap-2">
            <Button
              size="icon"
              onClick={onAccept}
              className="w-16 h-16 rounded-full bg-green-500 hover:bg-green-600 text-white shadow-lg shadow-green-500/30 animate-pulse"
            >
              {isVideo ? <Video className="w-7 h-7" /> : <Phone className="w-7 h-7" />}
            </Button>
            <span className="text-white/60 text-xs">Accepter</span>
          </div>
        </div>
      </div>
    </div>
  );
}
