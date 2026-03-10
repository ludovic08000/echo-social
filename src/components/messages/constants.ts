import { format, isToday, isYesterday } from 'date-fns';
import { fr } from 'date-fns/locale';

export const MESSAGE_REACTIONS = [
  { emoji: '❤️', label: 'love' },
  { emoji: '👍', label: 'like' },
  { emoji: '😂', label: 'laugh' },
  { emoji: '😮', label: 'wow' },
  { emoji: '😢', label: 'sad' },
  { emoji: '🔥', label: 'fire' },
];

export const EMOJI_CATEGORIES = [
  { label: '😀 Visages', emojis: ['😀','😂','🤣','😍','🥰','😘','😎','🤩','🥳','😇','🤗','🤭','😏','😌','🥺','😢','😭','😡','🤯','🫠','😴','🤑','🫡','🫶'] },
  { label: '❤️ Cœurs', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💖','💝','💘','💕','💗','💓','❤️‍🔥','💔','🫀'] },
  { label: '👋 Gestes', emojis: ['👋','👍','👎','👏','🙌','🤝','✌️','🤞','🤟','🤙','💪','🫰','👊','✊','🤌','🫶','🙏'] },
  { label: '🎉 Fête', emojis: ['🎉','🎊','🎈','🎁','🏆','🥇','⭐','🌟','✨','🔥','💥','💫','🎵','🎶','🎤','🎸'] },
  { label: '🍕 Nourriture', emojis: ['🍕','🍔','🍟','🌮','🍣','🍩','🍰','🧁','☕','🍷','🍺','🥂','🧋','🍓','🍑','🥑'] },
  { label: '🐱 Nature', emojis: ['🐱','🐶','🐻','🦊','🐼','🐨','🦁','🐸','🐵','🦋','🐝','🌸','🌺','🌻','🌈','☀️'] },
  { label: '💎 Premium', emojis: ['💎','👑','🦄','🌙','⚡','🪐','🔮','🎭','🗝️','🧿','🪬','💐','🦚','🎪','🏰','🚀','🛸','🧬'] },
];

export function formatMessageTime(dateStr: string) {
  const date = new Date(dateStr);
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return 'Hier';
  return format(date, 'dd/MM/yy');
}

export function formatDateSeparator(dateStr: string) {
  const date = new Date(dateStr);
  if (isToday(date)) return "Aujourd'hui";
  if (isYesterday(date)) return 'Hier';
  return format(date, 'EEEE d MMMM', { locale: fr });
}

export function isSingleEmoji(text: string): boolean {
  const emojiRegex = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}){1,3}$/u;
  return emojiRegex.test(text.trim());
}
