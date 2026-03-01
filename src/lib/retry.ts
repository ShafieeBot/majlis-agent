/**
 * Retry utility with exponential backoff for external API calls.
 * Used for Telegram, LLM, and other unreliable services.
 */

interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in ms (default: 500) */
  initialDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoff?: number;
  /** Maximum delay in ms (default: 10000) */
  maxDelayMs?: number;
  /** Optional predicate to decide if the error is retryable */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 500,
  backoff: 2,
  maxDelayMs: 10_000,
  isRetryable: () => true,
};

/**
 * Execute an async function with exponential backoff retry.
 *
 * @example
 * const result = await withRetry(() => fetch('https://api.telegram.org/...'), {
 *   maxAttempts: 3,
 *   isRetryable: (err) => !(err instanceof ValidationError),
 * });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt or if the error is not retryable
      if (attempt >= opts.maxAttempts || !opts.isRetryable(error)) {
        throw error;
      }

      // Exponential backoff with jitter
      const baseDelay = opts.initialDelayMs * Math.pow(opts.backoff, attempt - 1);
      const jitter = baseDelay * 0.2 * Math.random(); // 20% jitter
      const delay = Math.min(baseDelay + jitter, opts.maxDelayMs);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Check if an HTTP error status is retryable.
 * 4xx errors (except 429) are generally NOT retryable.
 * 5xx errors and 429 (rate limit) ARE retryable.
 */
export function isRetryableHttpError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    // Rate limited — retry after backoff
    if (msg.includes('429')) return true;
    // Server errors — retry
    if (/5\d{2}/.test(msg)) return true;
    // Client errors (400, 401, 403, 404) — don't retry
    if (/4\d{2}/.test(msg)) return false;
  }
  // Network errors, timeouts — retry
  return true;
}
