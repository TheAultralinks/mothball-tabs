/**
 * Logging.
 *
 * Deliberately narrow: logs carry counts, ids and API error messages, never page
 * titles or URLs. A tab title is user data and can contain anything, so it never
 * leaves the in-memory render path. Debug logging is opt-in from the options page.
 */

let debugEnabled = false;

export function setDebug(enabled) {
  debugEnabled = enabled === true;
}

export function debug(message, meta) {
  if (!debugEnabled) return;
  console.debug('[Mothball Tabs]', message, meta === undefined ? '' : safeMeta(meta));
}

export function info(message, meta) {
  console.info('[Mothball Tabs]', message, meta === undefined ? '' : safeMeta(meta));
}

export function warn(message, meta) {
  console.warn('[Mothball Tabs]', message, meta === undefined ? '' : safeMeta(meta));
}

/** Never throws: error reporting must not be able to break the caller. */
export function error(message, cause) {
  let detail = '';
  try {
    detail = cause instanceof Error ? cause.message : String(cause ?? '');
  } catch {
    detail = 'unprintable error';
  }
  console.error(`[Mothball Tabs] ${message}${detail ? `: ${detail}` : ''}`);
}

function safeMeta(meta) {
  if (meta instanceof Error) return meta.message;
  if (meta && typeof meta === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
      const type = typeof value;
      if (type === 'number' || type === 'boolean' || type === 'string') out[key] = value;
      else if (Array.isArray(value)) out[key] = value.length;
    }
    return out;
  }
  return meta;
}
