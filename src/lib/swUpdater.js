/**
 * PaperFate service worker update helper.
 *
 * Responsibilities:
 *   - Notify the page (via a 'paperfate:sw-updated' window event) when a new
 *     service worker takes control, so UI can offer a refresh.
 *   - Provide skipWaiting(reg) so the page can tell a waiting worker to
 *     activate (the actual UI wiring lives elsewhere).
 *   - Provide init() that periodically polls reg.update() on visibility change,
 *     so long-lived tabs notice deployed updates without a hard reload.
 *
 * SSR safe: all browser-only access is guarded.
 */

const UPDATE_EVENT = 'paperfate:sw-updated';
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 60 min

let controllerListenerAttached = false;
let initialized = false;
let lastUpdateCheckAt = 0;

function isBrowser() {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  );
}

function attachControllerListener() {
  if (controllerListenerAttached) return;
  if (!isBrowser()) return;
  try {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      try {
        window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
      } catch (_) {
        /* ignore */
      }
    });
    controllerListenerAttached = true;
  } catch (_) {
    /* ignore */
  }
}

// Eagerly attach the controllerchange listener on module import so the page
// is informed even if init() is never called.
attachControllerListener();

/**
 * Tell a waiting service worker to skip waiting and activate.
 * Safe to call with a missing/empty registration.
 */
export function skipWaiting(reg) {
  if (!isBrowser()) return;
  try {
    const waiting = reg && reg.waiting;
    if (waiting && typeof waiting.postMessage === 'function') {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  } catch (_) {
    /* ignore */
  }
}

async function pollForUpdate() {
  if (!isBrowser()) return;
  // Throttle: don't check more than once per POLL_INTERVAL_MS.
  const now = Date.now();
  if (now - lastUpdateCheckAt < POLL_INTERVAL_MS) return;
  lastUpdateCheckAt = now;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && typeof reg.update === 'function') {
      await reg.update();
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * Wire up periodic update polling. Idempotent.
 * Runs reg.update() at most once per 60 min, gated on visibilitychange.
 */
export function init() {
  if (initialized) return;
  if (!isBrowser()) return;
  initialized = true;

  attachControllerListener();

  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollForUpdate();
      }
    });
  } catch (_) {
    /* ignore */
  }
}

export const __test__ = { UPDATE_EVENT, POLL_INTERVAL_MS };
