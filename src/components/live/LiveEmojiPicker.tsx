import { useState, useRef, useEffect } from 'react';
import { Smile } from 'lucide-react';

const EMOJI_LIST = [
  '😀','😂','🤣','😍','🥰','😘','🤩','😎','🥳','🤗',
  '🔥','❤️','💯','👏','🙌','💪','✨','🎉','🎊','👑',
  '💀','😭','😱','🤯','🫣','🤭','😏','🥺','😡','🤬',
  '👍','👎','🤝','✌️','🤟','💜','💙','💚','💛','🧡',
  '⚡','🌟','💎','🏆','🎯','🎶','🎵','🫶','💋','🤑',
];

interface LiveEmojiPickerProps {
  onSelect: (emoji: string) => void;
}

export function LiveEmojiPicker({ onSelect }: LiveEmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white transition-colors"
      >
        <Smile className="w-5 h-5" />
      </button>

      {open && (
        <div className="absolute bottom-12 right-0 w-64 max-h-48 overflow-y-auto rounded-xl bg-black/80 backdrop-blur-md border border-white/10 p-2 grid grid-cols-8 gap-1 z-50">
          {EMOJI_LIST.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => { onSelect(emoji); setOpen(false); }}
              className="w-7 h-7 flex items-center justify-center text-lg hover:bg-white/20 rounded transition-colors"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
