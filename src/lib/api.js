/**
 * Defensive wrappers around the extension APIs.
 *
 * A browser extension drives an API that fails in ordinary, expected ways:
 * a tab closed between the moment we listed it and the moment we act on it, a
 * restricted page, a storage backend that is briefly unavailable. Getting that
 * wrong is how extensions end up with half-applied actions and no explanation.
 *
 * The rules used here:
 *   - every call gets a timeout, so the UI can never hang forever,
 *   - only transient failures are retried, and with exponential backoff + jitter,
 *   - retries are gated by a retry budget (a circuit breaker for retries), so a
 *     genuinely broken API is reported instead of hammered,
 *   - bulk work is chunked with a small gap, so a 300-tab action does not stall
 *     the browser or the popup.
 *
 * Every operation is idempotent from the caller's point of view: acting on a tab
 * that is already gone is recorded as "failed", never retried into a mistake.
 */

export const DEFAULT_TIMEOUT_MS = 8000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects if `promise` has not settled in `ms` milliseconds. */
export function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'operation') {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Errors that mean "this will never work", so retrying is pointless.
 * Matching is on Chrome's error strings, which are stable and short.
 */
const PERMANENT_ERROR_HINTS = [
  'invalid tab',
  'no tab with id',
  'no window with id',
  'cannot access',
  'cannot be edited',
  'not allowed',
  'permission',
  'denied',
  'incognito',
  'not supported',
  'cannot group',
  'no group with id',
];

export function isRetryableError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) return false;
  if (message.includes('timed out')) return true;
  return !PERMANENT_ERROR_HINTS.some((hint) => message.includes(hint));
}

/** Exponential backoff with jitter: 1st retry ~80ms, then ~160, ~320, capped. */
export function backoffDelay(attempt, baseMs = 80, maxMs = 2000) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.5 + Math.random() * 0.5; // 50-100% of the delay
  return Math.round(exponential * jitter);
}

/**
 * Circuit breaker for retries only. First attempts are always made: a tab close
 * should not be blocked because storage was unhappy a second ago. Once the
 * budget trips, retries pause for a cooldown and the caller surfaces the error.
 */
export class RetryBudget {
  constructor({ threshold = 6, cooldownMs = 15000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = 0;
  }

  get isOpen() {
    if (this.failures < this.threshold) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      // Half-open: allow a single probe through.
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  allowRetry() {
    return !this.isOpen;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  recordSuccess() {
    this.failures = 0;
  }
}

/**
 * Calls `fn`, retrying transient failures with backoff.
 * `attempts` counts the first try, so attempts: 2 means one retry.
 */
export async function callWithRetry(label, fn, { attempts = 2, timeoutMs = DEFAULT_TIMEOUT_MS, budget = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      const value = await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
      budget?.recordSuccess();
      return value;
    } catch (error) {
      lastError = error;
      const canRetry = attempt + 1 < attempts && isRetryableError(error);
      if (!canRetry) break;
      if (budget && !budget.allowRetry()) break;
      budget?.recordFailure();
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? `${label} failed`));
}

/**
 * Runs `worker` over `items` in small parallel chunks.
 * Never throws for a single bad item: returns what worked and what did not, so
 * the UI can say "closed 12 of 14" instead of silently doing nothing.
 */
export async function runBatched(items, worker, { concurrency = 6, gapMs = 8, onProgress = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(24, concurrency));
  const ok = [];
  const failed = [];

  for (let index = 0; index < list.length; index += size) {
    const chunk = list.slice(index, index + size);
    const outcomes = await Promise.all(
      chunk.map(async (item) => {
        try {
          await worker(item);
          return { item, ok: true };
        } catch (error) {
          return { item, ok: false, error: String(error?.message || error || 'unknown error') };
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.ok) ok.push(outcome.item);
      else failed.push({ item: outcome.item, error: outcome.error });
    }
    if (onProgress) onProgress(ok.length + failed.length, list.length);
    if (gapMs && index + size < list.length) await sleep(gapMs);
  }

  return { ok, failed };
}
