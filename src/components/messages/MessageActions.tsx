import { Reply, Forward, Pin, PinOff, Copy, Trash2, Flag, X } from 'lucide-react';
import { MESSAGE_REACTIONS } from './constants';

interface MessageActionsProps {
  isMe: boolean;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onDeleteForMe: () => void;
  onDeleteForEveryone?: () => void;
  onReport: () => void;
  onForward: () => void;
  onPin: () => void;
  isPinned: boolean;
  visible: boolean;
  onClose: () => void;
}

export function MessageActions({
  isMe, onReply, onReact, onCopy, onDeleteForMe, onDeleteForEveryone, onReport, onForward, onPin, isPinned, visible, onClose
}: MessageActionsProps) {
  if (!visible) return null;

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-col gap-2 p-3 pb-6 animate-in slide-in-from-bottom-8 duration-200 safe-area-pb">
        {/* Reactions row */}
        <div className="flex items-center justify-center gap-1 px-3 py-2 rounded-2xl bg-background/95 shadow-xl border border-border/30 mx-auto">
          {MESSAGE_REACTIONS.map(r => (
            <button
              key={r.label}
              onClick={() => { onReact(r.emoji); onClose(); }}
              className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-secondary/80 hover:scale-125 active:scale-90 transition-all text-xl"
            >
              {r.emoji}
            </button>
          ))}
        </div>
        {/* Actions */}
        <div className="bg-background/95 shadow-xl rounded-2xl border border-border/30 overflow-hidden">
          <button onClick={() => { onReply(); onClose(); }} className="w-full flex items-center gap-3 px-5 py-3 text-sm hover:bg-secondary/60 transition-colors">
            <Reply className="w-4 h-4 text-muted-foreground" /> Répondre
          </button>
          <button onClick={() => { onForward(); onClose(); }} className="w-full flex items-center gap-3 px-5 py-3 text-sm hover:bg-secondary/60 transition-colors">
            <Forward className="w-4 h-4 text-muted-foreground" /> Transférer
          </button>
          <button onClick={() => { onPin(); onClose(); }} className="w-full flex items-center gap-3 px-5 py-3 text-sm hover:bg-secondary/60 transition-colors">
            {isPinned ? <PinOff className="w-4 h-4 text-muted-foreground" /> : <Pin className="w-4 h-4 text-muted-foreground" />}
            {isPinned ? 'Désépingler' : 'Épingler'}
          </button>
          <button onClick={() => { onCopy(); onClose(); }} className="w-full flex items-center gap-3 px-5 py-3 text-sm hover:bg-secondary/60 transition-colors">
            <Copy className="w-4 h-4 text-muted-foreground" /> Copier
          </button>
          <div className="h-px bg-border/20 mx-3" />
          <button onClick={() => { onDeleteForMe(); onClose(); }} className="w-full flex items-center gap-3 px-5 py-3 text-sm text-destructive hover:bg-destructive/10 transition-colors">
            <Trash2 className="w-4 h-4" /> Supprimer pour moi
          </button>
          {isMe && onDeleteForEveryone && (
            <button onClick={() => { onDeleteForEveryone(); onClose(); }} className="w-full flex items-center gap-3 px-5 py-3 text-sm text-destructive hover:bg-destructive/10 transition-colors font-medium">
              <Trash2 className="w-4 h-4" /> Supprimer pour tous
            </button>
          )}
          {!isMe && (
            <button onClick={() => { onReport(); onClose(); }} className="w-full flex items-center gap-3 px-5 py-3 text-sm text-amber-600 hover:bg-amber-500/10 transition-colors">
              <Flag className="w-4 h-4" /> Signaler
            </button>
          )}
        </div>
        {/* Cancel */}
        <button
          onClick={onClose}
          className="w-full py-3 rounded-2xl bg-background/95 shadow-xl border border-border/30 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Annuler
        </button>
      </div>
    </>
  );
}
