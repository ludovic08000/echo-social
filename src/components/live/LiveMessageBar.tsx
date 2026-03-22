import { useState } from 'react';
import { Send, Smile } from 'lucide-react';
import { motion } from 'framer-motion';

interface LiveMessageBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function LiveMessageBar({ onSend, disabled }: LiveMessageBarProps) {
  const [message, setMessage] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    onSend(message.trim());
    setMessage('');
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <div className="flex-1 flex items-center gap-2 px-4 py-2 rounded-full bg-white/8 backdrop-blur-md border border-white/10 focus-within:border-[hsl(220_70%_55%/0.5)] transition-colors">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Envoyer un message..."
          disabled={disabled}
          className="flex-1 bg-transparent text-white text-sm placeholder:text-white/30 outline-none"
        />
        <button type="button" className="text-white/40 hover:text-white/70 transition-colors">
          <Smile className="w-4.5 h-4.5" />
        </button>
      </div>
      <motion.button
        whileTap={{ scale: 0.85 }}
        type="submit"
        disabled={!message.trim() || disabled}
        className="w-9 h-9 rounded-full flex items-center justify-center text-white disabled:opacity-30 transition-opacity"
        style={{
          background: 'linear-gradient(135deg, hsl(260 70% 55%), hsl(220 70% 55%))',
          boxShadow: message.trim() ? '0 0 15px hsl(220 70% 55% / 0.4)' : 'none',
        }}
      >
        <Send className="w-3.5 h-3.5" />
      </motion.button>
    </form>
  );
}
