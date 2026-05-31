// PaperFate · Web Push notifications client.
//
// SSR-safe wrapper around the browser Push API. The server-side
// delivery half (web-push, VAPID signing, scheduled fan-out) is *not*
// part of this module — this only covers permission, subscription, and
// shipping the resulting subscription record to /api/push-subscribe so
// it can be stored for later delivery.
//
// VAPID key plumbing: the public key is read at call time from the
// build-injected global `window.__PAPERFATE_VAPID_PUBLIC_KEY__`. When
// the global is absent (current state — server-side push not yet wired)
// subscribe() resolves to a structured `{ ok:false, reason }` instead
// of throwing, so callers can degrade gracefully.
//
// API surface:
//   - isSupported()        -> boolean
//   - getPermission()      -> 'granted' | 'denied' | 'default' | 'unsupported'
//   - requestPermission()  -> Promise<NotificationPermission | 'unsupported'>
//   - subscribe()          -> Promise<{ ok:true, subscription } | { ok:false, reason, detail? }>
//
// All entry points are safe to import in SSR / non-browser contexts —
// they branch on `typeof window` and friends before touching anything.

const ENDPOINT = '/api/push-subscribe'
const VAPID_GLOBAL = '__PAPERFATE_VAPID_PUBLIC_KEY__'

function hasWindow() {
  return typeof window !== 'undefined'
}

export function isSupported() {
  if (!hasWindow()) return false
  try {
    return (
      typeof window.Notification === 'function' &&
      'serviceWorker' in navigator &&
      typeof window.ServiceWorkerRegistration === 'function' &&
      'PushManager' in window &&
      typeof window.PushManager === 'function'
    )
  } catch {
    return false
  }
}

export function getPermission() {
  if (!hasWindow() || typeof window.Notification !== 'function') return 'unsupported'
  try {
    const p = window.Notification.permission
    if (p === 'granted' || p === 'denied' || p === 'default') return p
    return 'default'
  } catch {
    return 'unsupported'
  }
}

export async function requestPermission() {
  if (!isSupported()) return 'unsupported'
  try {
    // Notification.requestPermission supports both the legacy callback
    // form and the modern Promise form. Promise-wrapping handles both.
    const result = await new Promise((resolve) => {
      try {
        const ret = window.Notification.requestPermission((perm) => resolve(perm))
        if (ret && typeof ret.then === 'function') {
          ret.then(resolve, () => resolve('default'))
        }
      } catch {
        resolve('default')
      }
    })
    if (result === 'granted' || result === 'denied' || result === 'default') {
      return result
    }
    return 'default'
  } catch {
    return 'default'
  }
}

function readVapidPublicKey() {
  if (!hasWindow()) return ''
  try {
    const k = window[VAPID_GLOBAL]
    return typeof k === 'string' && k.length > 0 ? k : ''
  } catch {
    return ''
  }
}

// Convert URL-safe base64 (RFC 4648 §5) to a Uint8Array — required by
// PushManager.subscribe(applicationServerKey).
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = typeof atob === 'function' ? atob(base64) : ''
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function postSubscription(subscription) {
  if (!hasWindow() || typeof fetch !== 'function') {
    return { ok: false, status: 0, body: null }
  }
  // Subscription objects serialise cleanly via toJSON(). Falling back to
  // a manual shape keeps things working if a polyfill misses toJSON.
  let payload
  try {
    payload = typeof subscription.toJSON === 'function'
      ? subscription.toJSON()
      : {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        }
  } catch {
    payload = { endpoint: subscription.endpoint, keys: subscription.keys }
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    })
    let body = null
    try { body = await res.json() } catch { /* non-JSON 503 etc. */ }
    return { ok: res.ok, status: res.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: null, error: String((e && e.message) || e) }
  }
}

export async function subscribe() {
  if (!isSupported()) return { ok: false, reason: 'unsupported' }
  if (getPermission() !== 'granted') return { ok: false, reason: 'permission_denied' }

  const vapidKey = readVapidPublicKey()
  if (!vapidKey) return { ok: false, reason: 'vapid_key_missing' }

  let reg
  try {
    reg = await navigator.serviceWorker.ready
  } catch (e) {
    return { ok: false, reason: 'sw_unavailable', detail: String((e && e.message) || e) }
  }
  if (!reg || !reg.pushManager || typeof reg.pushManager.subscribe !== 'function') {
    return { ok: false, reason: 'pushmanager_unavailable' }
  }

  let applicationServerKey
  try {
    applicationServerKey = urlBase64ToUint8Array(vapidKey)
  } catch (e) {
    return { ok: false, reason: 'vapid_key_invalid', detail: String((e && e.message) || e) }
  }

  let subscription
  try {
    // Try to reuse an existing subscription first — most browsers
    // dedupe under the hood, but explicit reuse keeps the on-disk log
    // honest on repeat opt-ins.
    const existing = await reg.pushManager.getSubscription()
    subscription = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    })
  } catch (e) {
    return { ok: false, reason: 'subscribe_failed', detail: String((e && e.message) || e) }
  }

  const posted = await postSubscription(subscription)
  if (!posted.ok) {
    return {
      ok: false,
      reason: posted.status === 503 ? 'push_disabled' : 'post_failed',
      detail: posted.body || posted.error || `http_${posted.status}`,
      subscription,
    }
  }
  return { ok: true, subscription, server: posted.body || null }
}
