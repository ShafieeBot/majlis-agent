/**
 * Structured logger — wraps pino for JSON-formatted, leveled logging.
 *
 * GAP-L2 CLOSED: Replaced raw console.log/error/warn with structured logging.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info({ event: 'message_sent', chatId }, 'Message sent');
 *   logger.error({ err, conversationId }, 'Failed to process message');
 */

import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  ...(isProduction
    ? {
        // JSON output in production for log aggregation
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        // Pretty output in development
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
  // Redact sensitive fields from logs (GAP-L1 partial: scrub PII)
  redact: {
    paths: [
      'apiKey',
      'accessToken',
      'botToken',
      'secret',
      'password',
      'token',
      'req.headers["x-agent-secret"]',
      'req.headers["x-admin-secret"]',
      'req.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
});

/**
 * Create a child logger scoped to a specific module.
 */
export function createModuleLogger(module: string) {
  return logger.child({ module });
}
