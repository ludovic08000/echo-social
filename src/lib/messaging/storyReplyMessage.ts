export interface StoryReplyMessage {
  body: string;
}

/**
 * Build the encrypted text sent when somebody replies to a story.
 *
 * The story URL is intentionally not returned here: it belongs to the story
 * transport and does not have an Aegis message-media key (MKEY).
 */
export function buildStoryReplyMessage(message: string): StoryReplyMessage {
  return {
    body: `↩️ Réponse à votre story : ${message.trim()}`,
  };
}
