import { useState } from 'react';
import { Heart, MessageCircle, Share2, Bookmark, MoreHorizontal, UserPlus } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { ShareButton } from '@/components/ShareButton';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface LiveRightActionsProps {
  hostAvatar?: string | null;
  hostName?: string;
  viewerCount: number;
  onCommentClick?: () => void;
  shareUrl?: string;
  shareTitle?: string;
}

function ActionButton({
  icon: Icon,
  label,
  active,
  onClick,
  activeColor,
}: {
  icon: any;
  label: string;
  active?: boolean;
  onClick?: () => void;
  activeColor?: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.85 }}
      onClick={onClick}
      className="flex flex-col items-center gap-1"
    >
      <div
        className={cn(
          'w-11 h-11 rounded-full flex items-center justify-center backdrop-blur-md transition-all duration-200',
          active
            ? 'bg-white/20 shadow-[0_0_15px_hsl(220_70%_55%/0.4)]'
            : 'bg-white/8 hover:bg-white/15'
        )}
        style={active && activeColor ? { background: activeColor } : undefined}
      >
        <Icon className={cn('w-5 h-5', active ? 'text-white' : 'text-white/90')} />
      </div>
      <span className="text-white/60 text-[9px] font-medium">{label}</span>
    </motion.button>
  );
}

export function LiveRightActions({ hostAvatar, hostName, viewerCount, onCommentClick, shareUrl, shareTitle }: LiveRightActionsProps) {
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [followed, setFollowed] = useState(false);

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Host avatar with follow button */}
      <div className="relative mb-1">
        <div className={cn('rounded-full p-[2px] transition-all')}
          style={!followed ? {
            background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(190 80% 50%))',
          } : undefined}
        >
          <UserAvatar src={hostAvatar} alt={hostName} size="md" />
        </div>
        {!followed && (
          <motion.button
            whileTap={{ scale: 0.8 }}
            onClick={() => setFollowed(true)}
            className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%))',
              boxShadow: '0 2px 8px hsl(220 70% 55% / 0.5)',
            }}
          >
            <UserPlus className="w-2.5 h-2.5 text-white" />
          </motion.button>
        )}
      </div>

      <ActionButton
        icon={Heart}
        label="J'aime"
        active={liked}
        onClick={() => setLiked(!liked)}
        activeColor="linear-gradient(135deg, hsl(340 80% 55%), hsl(320 70% 50%))"
      />

      <ActionButton
        icon={MessageCircle}
        label="Chat"
        onClick={onCommentClick}
      />

      {/* Real share button using ShareButton component */}
      <div className="flex flex-col items-center gap-1">
        <ShareButton
          url={shareUrl || ''}
          title={shareTitle || ''}
          variant="ghost"
          size="icon"
          className="w-11 h-11 rounded-full bg-white/8 backdrop-blur-md text-white/90 hover:bg-white/15"
        />
        <span className="text-white/60 text-[9px] font-medium">Partager</span>
      </div>

      <ActionButton
        icon={Bookmark}
        label="Sauver"
        active={saved}
        onClick={() => setSaved(!saved)}
        activeColor="linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%))"
      />

      <ActionButton
        icon={MoreHorizontal}
        label="Plus"
      />
    </div>
  );
}
