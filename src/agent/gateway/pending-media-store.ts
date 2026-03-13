/**
 * In-memory store for pending media attachments.
 *
 * When a guest sends a photo and the agent decides to ask before saving,
 * the photo buffer is stored here keyed by conversationId.
 * When the guest confirms, submit_photo retrieves it from here.
 *
 * Entries auto-expire after 10 minutes to avoid memory leaks.
 */

import type { MediaAttachment } from './types';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

interface PendingEntry {
  media: MediaAttachment;
  expiresAt: number;
}

const store = new Map<string, PendingEntry>();

/**
 * Store a media attachment for later retrieval.
 */
export function storePendingMedia(conversationId: string, media: MediaAttachment): void {
  store.set(conversationId, {
    media,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Retrieve and remove a pending media attachment.
 * Returns null if not found or expired.
 */
export function retrievePendingMedia(conversationId: string): MediaAttachment | null {
  const entry = store.get(conversationId);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    store.delete(conversationId);
    return null;
  }

  store.delete(conversationId);
  return entry.media;
}

/**
 * Check if there is a pending media attachment (without removing it).
 */
export function hasPendingMedia(conversationId: string): boolean {
  const entry = store.get(conversationId);
  if (!entry) return false;

  if (Date.now() > entry.expiresAt) {
    store.delete(conversationId);
    return false;
  }

  return true;
}

/**
 * Clean up expired entries. Called periodically.
 */
export function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpired, 5 * 60 * 1000).unref();
