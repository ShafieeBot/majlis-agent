/**
 * Sentry error tracking integration.
 *
 * GAP-O2 CLOSED: Sentry captures unhandled exceptions and provides
 * external alerting + error triage in production.
 *
 * Set SENTRY_DSN in environment to enable. When not set, Sentry is a no-op.
 */

import * as Sentry from '@sentry/node';
import { createModuleLogger } from './logger';

const log = createModuleLogger('sentry');

let initialized = false;

/**
 * Initialize Sentry if SENTRY_DSN is set.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initSentry(): void {
  if (initialized) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    log.info('SENTRY_DSN not set — Sentry disabled');
    initialized = true;
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.npm_package_version ?? 'unknown',
    // Only send errors in production — don't send in dev/test
    enabled: process.env.NODE_ENV === 'production',
    // Sample rate for performance monitoring (0 = disabled)
    tracesSampleRate: 0,
    // Scrub sensitive data
    beforeSend(event) {
      // Remove headers that might contain secrets
      if (event.request?.headers) {
        delete event.request.headers['x-agent-secret'];
        delete event.request.headers['x-admin-secret'];
        delete event.request.headers['authorization'];
      }
      return event;
    },
  });

  log.info('Sentry initialized');
  initialized = true;
}

/**
 * Capture an exception in Sentry with optional context.
 */
export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (context) {
    Sentry.withScope((scope) => {
      scope.setExtras(context);
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
}

/**
 * Set user context for Sentry events.
 */
export function setSentryUser(user: { id: string; username?: string }): void {
  Sentry.setUser(user);
}

// Re-export Sentry for direct usage if needed
export { Sentry };
