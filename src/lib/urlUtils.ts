import { z } from 'zod';

// ============================================
// URL Validation Schemas
// ============================================

// Schema for validating URLs
export const urlSchema = z
  .string()
  .url({ message: 'URL invalide' })
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
      } catch {
        return false;
      }
    },
    { message: 'Seuls les protocoles HTTP et HTTPS sont autorisés' }
  );

// Schema for optional URLs
export const optionalUrlSchema = z
  .string()
  .optional()
  .refine(
    (url) => {
      if (!url || url.trim() === '') return true;
      try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
      } catch {
        return false;
      }
    },
    { message: 'URL invalide' }
  );

// ============================================
// URL Sanitization
// ============================================

export function sanitizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    
    // Only allow safe protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    // Block dangerous patterns
    const dangerousPatterns = [
      /javascript:/i,
      /data:/i,
      /vbscript:/i,
      /file:/i,
      /<script/i,
      /on\w+=/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmed)) {
        return null;
      }
    }

    return parsed.href;
  } catch {
    return null;
  }
}

// ============================================
// Shareable URL Generators
// ============================================

export function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return import.meta.env.VITE_APP_URL || 'https://pulse.app';
}

export function generateProfileUrl(userId: string): string {
  return `${getBaseUrl()}/profile/${encodeURIComponent(userId)}`;
}

export function generatePostUrl(postId: string): string {
  return `${getBaseUrl()}/post/${encodeURIComponent(postId)}`;
}

export function generateLiveUrl(liveId: string): string {
  return `${getBaseUrl()}/live/${encodeURIComponent(liveId)}`;
}

export function generateVideoUrl(videoId: string): string {
  return `${getBaseUrl()}/videos?v=${encodeURIComponent(videoId)}`;
}

export function generateGroupUrl(groupId: string): string {
  return `${getBaseUrl()}/groups/${encodeURIComponent(groupId)}`;
}

export function generatePageUrl(pageId: string): string {
  return `${getBaseUrl()}/pages/${encodeURIComponent(pageId)}`;
}

export function generateMessageUrl(conversationId: string): string {
  return `${getBaseUrl()}/messages/${encodeURIComponent(conversationId)}`;
}

// ============================================
// Secure Token URL Generators
// ============================================

export function generateSecureToken(length: number = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function generatePasswordResetUrl(token: string): string {
  return `${getBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}

export function generateEmailVerificationUrl(token: string): string {
  return `${getBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

export function generateInviteUrl(inviteCode: string): string {
  return `${getBaseUrl()}/invite/${encodeURIComponent(inviteCode)}`;
}

// ============================================
// Share Functions
// ============================================

export interface ShareData {
  url: string;
  title?: string;
  text?: string;
}

export async function shareUrl(data: ShareData): Promise<boolean> {
  // Try Web Share API first (mobile-friendly)
  if (navigator.share) {
    try {
      await navigator.share({
        title: data.title,
        text: data.text,
        url: data.url,
      });
      return true;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return false; // User cancelled
      }
      // Fall through to clipboard
    }
  }

  // Fallback to clipboard
  try {
    await navigator.clipboard.writeText(data.url);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// URL Parameter Extraction
// ============================================

export function extractTokenFromUrl(paramName: string = 'token'): string | null {
  if (typeof window === 'undefined') return null;
  
  const params = new URLSearchParams(window.location.search);
  const token = params.get(paramName);
  
  if (!token) return null;
  
  // Validate token format (alphanumeric)
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    return null;
  }
  
  return token;
}

export function extractIdFromUrl(paramName: string): string | null {
  if (typeof window === 'undefined') return null;
  
  const params = new URLSearchParams(window.location.search);
  const id = params.get(paramName);
  
  if (!id) return null;
  
  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return null;
  }
  
  return id;
}

// ============================================
// Protected Routes List
// ============================================

export const PUBLIC_ROUTES = [
  '/',
  '/login',
  '/signup',
  '/reset-password',
  '/verify-email',
  '/invite',
];

export const PROTECTED_ROUTES = [
  '/feed',
  '/profile',
  '/messages',
  '/notifications',
  '/settings',
  '/create',
  '/friends',
  '/groups',
  '/pages',
  '/videos',
  '/lives',
  '/live',
  '/post',
  '/search',
];

export function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_ROUTES.some(route => pathname.startsWith(route));
}

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(route => 
    pathname === route || pathname.startsWith(`${route}/`)
  );
}
