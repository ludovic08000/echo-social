import { useEffect, useState } from 'react';
import { Room, RoomEvent, Participant, Track } from 'livekit-client';
import { Mic, MicOff, VideoOff, User } from 'lucide-react';

interface ParticipantInfo {
  identity: string;
  name?: string;
  avatar?: string;
}

interface GroupCallGridProps {
  room: Room | null;
  localParticipantName?: string;
  localParticipantAvatar?: string;
  participantsInfo?: Record<string, ParticipantInfo>;
}

/**
 * Adaptive grid for 1-8 participants.
 * 1 = full-screen, 2 = side-by-side, 3-4 = 2x2, 5-6 = 2x3, 7-8 = 3x3
 */
export function GroupCallGrid({ room, localParticipantName, localParticipantAvatar, participantsInfo = {} }: GroupCallGridProps) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!room) return;

    const refresh = () => {
      setParticipants(Array.from(room.remoteParticipants.values()));
      forceTick(t => t + 1);
    };
    refresh();

    const events: (keyof typeof RoomEvent)[] = [
      'ParticipantConnected', 'ParticipantDisconnected',
      'TrackSubscribed', 'TrackUnsubscribed',
      'TrackMuted', 'TrackUnmuted',
      'LocalTrackPublished', 'LocalTrackUnpublished',
    ];
    events.forEach(e => room.on(RoomEvent[e] as any, refresh));
    return () => { events.forEach(e => room.off(RoomEvent[e] as any, refresh)); };
  }, [room]);

  const totalCount = participants.length + 1; // +local
  const gridCols = totalCount <= 1 ? 'grid-cols-1'
    : totalCount === 2 ? 'grid-cols-2'
    : totalCount <= 4 ? 'grid-cols-2'
    : 'grid-cols-3';
  const gridRows = totalCount <= 2 ? 'grid-rows-1'
    : totalCount <= 4 ? 'grid-rows-2'
    : totalCount <= 6 ? 'grid-rows-2'
    : 'grid-rows-3';

  return (
    <div className={`grid ${gridCols} ${gridRows} gap-1 sm:gap-2 w-full h-full p-2`}>
      {/* Local participant tile */}
      <ParticipantTile
        participant={room?.localParticipant ?? null}
        isLocal
        name={localParticipantName ?? 'Vous'}
        avatar={localParticipantAvatar}
      />
      {participants.map(p => (
        <ParticipantTile
          key={p.sid}
          participant={p}
          name={participantsInfo[p.identity]?.name ?? p.name ?? p.identity}
          avatar={participantsInfo[p.identity]?.avatar}
        />
      ))}
    </div>
  );
}

interface ParticipantTileProps {
  participant: Participant | null;
  isLocal?: boolean;
  name: string;
  avatar?: string;
}

function ParticipantTile({ participant, isLocal = false, name, avatar }: ParticipantTileProps) {
  const videoRef = (el: HTMLVideoElement | null) => {
    if (!el || !participant) return;
    const cam = participant.getTrackPublication(Track.Source.Camera);
    if (cam?.track && !cam.isMuted) {
      cam.track.attach(el);
    }
  };

  const audioRef = (el: HTMLAudioElement | null) => {
    if (!el || !participant || isLocal) return;
    const mic = participant.getTrackPublication(Track.Source.Microphone);
    if (mic?.track) mic.track.attach(el);
  };

  const cam = participant?.getTrackPublication(Track.Source.Camera);
  const mic = participant?.getTrackPublication(Track.Source.Microphone);
  const hasCamera = !!cam && !cam.isMuted;
  const isMicMuted = !mic || mic.isMuted;

  return (
    <div className="relative w-full h-full bg-black/60 rounded-2xl overflow-hidden flex items-center justify-center">
      {hasCamera ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-white/80">
          {avatar ? (
            <img src={avatar} alt={name} className="w-20 h-20 rounded-full object-cover border-2 border-white/30" />
          ) : (
            <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center">
              <User className="w-10 h-10" />
            </div>
          )}
          <div className="flex items-center gap-1">
            <VideoOff className="w-3 h-3 opacity-60" />
            <span className="text-xs">Caméra coupée</span>
          </div>
        </div>
      )}

      {!isLocal && <audio ref={audioRef} autoPlay />}

      {/* Name + mic indicator */}
      <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between bg-black/50 backdrop-blur px-2 py-1 rounded-lg">
        <span className="text-white text-xs font-medium truncate">{isLocal ? `${name} (vous)` : name}</span>
        {isMicMuted ? <MicOff className="w-3 h-3 text-red-400 shrink-0" /> : <Mic className="w-3 h-3 text-green-400 shrink-0" />}
      </div>
    </div>
  );
}
