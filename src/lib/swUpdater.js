/**
 * PaperFate service worker update helper.
 *
 * Responsibilities:
 *   - Notify the page (via a 'paperfate:sw-updated' window event) when a new
 *     service worker takes control, so UI can offer a refresh.
 *   - Notify the page (via a 'paperfate:sw-waiting' window event with
 *     { registration } detail) when a periodic check discovers reg.waiting
 *     has become non-null but the old worker is still controlling. The UI
 *     toast listens for this to surface an "Update available" prompt.
 *   - Provide skipWaiting(reg) so the page can tell a waiting worker to
 *     activate (the actual UI wiring lives elsewhere).
 *   - Provide init() that periodically polls reg.update() on visibility change,
 *     so long-lived tabs notice deployed updates without a hard reload.
 *
 * SSR safe: all browser-only access is guarded.
 */

const UPDATE_EVENT = 'paperfate:sw-updated';
const WAITING_EVENT = 'paperfate:sw-waiting';
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 60 min — gate for reg.update()
const WAITING_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min — gate for waiting check

let controllerListenerAttached = false;
let initialized = false;
let lastUpdateCheckAt = 0;
let lastWaitingCheckAt = 0;
let lastWaitingDispatchedFor = null;

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
 * Check whether the current registration has a waiting worker, and if so
 * fire 'paperfate:sw-waiting' with the registration in the detail. Throttled
 * to WAITING_POLL_INTERVAL_MS to avoid hammering the SW machinery. We also
 * de-dupe so the same waiting worker doesn't repeatedly trigger the event
 * (the toast already handles its own dismissed state, but we avoid noise).
 */
async function pollForWaiting() {
  if (!isBrowser()) return;
  const now = Date.now();
  if (now - lastWaitingCheckAt < WAITING_POLL_INTERVAL_MS) return;
  lastWaitingCheckAt = now;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const waiting = reg.waiting;
    if (!waiting) {
      // Reset the de-dupe key so a future waiting worker is announced.
      lastWaitingDispatchedFor = null;
      return;
    }
    if (lastWaitingDispatchedFor === waiting) return;
    lastWaitingDispatchedFor = waiting;
    try {
      window.dispatchEvent(
        new CustomEvent(WAITING_EVENT, { detail: { registration: reg } })
      );
    } catch (_) {
      /* ignore */
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * Wire up periodic update polling. Idempotent.
 * Runs reg.update() at most once per 60 min, gated on visibilitychange.
 * Also checks for reg.waiting at most once per 5 min on visibilitychange
 * and fires 'paperfate:sw-waiting' so UI can offer reload.
 */
export function init() {
  if (initialized) return;
  if (!isBrowser()) return;
  initialized = true;

  attachControllerListener();

  // Run an initial waiting check shortly after init so a tab opened while
  // a previously installed worker is already waiting still sees the toast.
  try {
    pollForWaiting();
  } catch (_) {
    /* ignore */
  }

  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollForUpdate();
        pollForWaiting();
      }
    });
  } catch (_) {
    /* ignore */
  }
}

export const __test__ = {
  UPDATE_EVENT,
  WAITING_EVENT,
  POLL_INTERVAL_MS,
  WAITING_POLL_INTERVAL_MS,
};
