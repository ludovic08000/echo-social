/**
 * Messaging Service Abstraction Layer
 * 
 * This module defines the interfaces for an external messaging API.
 * When you're ready to connect a real messaging provider (e.g., Twilio, SendBird, Stream),
 * implement the MessagingProvider interface and register it.
 */

export interface ExternalMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  imageUrl?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalConversation {
  id: string;
  participants: string[];
  lastMessage?: ExternalMessage;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessagePayload {
  conversationId: string;
  body: string;
  imageUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationPayload {
  participantIds: string[];
  initialMessage?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Interface for external messaging providers.
 * Implement this interface to connect a third-party messaging API.
 */
export interface MessagingProvider {
  /** Provider name for logging and debugging */
  readonly name: string;

  /** Initialize the provider (called once at startup) */
  initialize(config: Record<string, unknown>): Promise<void>;

  /** Fetch all conversations for a user */
  getConversations(userId: string): Promise<ExternalConversation[]>;

  /** Fetch messages for a conversation */
  getMessages(conversationId: string, options?: { limit?: number; before?: string }): Promise<ExternalMessage[]>;

  /** Send a message */
  sendMessage(payload: SendMessagePayload): Promise<ExternalMessage>;

  /** Create a new conversation */
  createConversation(payload: CreateConversationPayload): Promise<ExternalConversation>;

  /** Mark a conversation as read */
  markAsRead(conversationId: string, userId: string): Promise<void>;

  /** Subscribe to real-time message updates */
  onMessage(conversationId: string, callback: (message: ExternalMessage) => void): () => void;

  /** Disconnect and cleanup */
  disconnect(): Promise<void>;
}
