// Minimal browser compatibility polyfills for older Safari (< 15.4) and
// older Chromium (< 98). Each shim is opt-in: we only patch when the host
// platform lacks the API, so modern engines pay no cost.
//
// SSR-safe: the file may be evaluated in Node during SSR/test contexts.
// We resolve a single `globalRef` that points to `globalThis` when
// available, falling back to `self`, `window`, or `global` so that
// referencing `globalThis.AbortSignal` etc. never throws.
//
// NO new dependencies. Pure ES.

;(function installPolyfills() {
  // Resolve a global object regardless of environment.
  const globalRef =
    typeof globalThis !== 'undefined'
      ? globalThis
      : typeof self !== 'undefined'
        ? self
        : typeof window !== 'undefined'
          ? window
          : typeof global !== 'undefined'
            ? global
            : {}

  // ---- structuredClone ------------------------------------------------
  // Older Safari (< 15.4) and older Chromium lack structuredClone. The
  // JSON.parse(JSON.stringify(x)) fallback is well-known but has caveats:
  // it silently drops functions, undefined, symbols, Map/Set, Date becomes
  // ISO string, etc. That is acceptable for our use which only serialises
  // plain data shapes (forecast inputs, telemetry payloads). We try to
  // handle a couple of common cases (Date, primitive passthrough) without
  // pulling in a real polyfill.
  if (typeof globalRef.structuredClone !== 'function') {
    globalRef.structuredClone = function structuredCloneShim(value) {
      // Primitives and null/undefined pass through unchanged.
      if (value === null || value === undefined) return value
      const t = typeof value
      if (t !== 'object' && t !== 'function') return value
      // Date round-trip preserves the timestamp.
      if (value instanceof Date) return new Date(value.getTime())
      try {
        return JSON.parse(JSON.stringify(value))
      } catch (_err) {
        // Cyclic or non-serialisable input: return the original reference.
        // This matches "best effort" semantics; callers that need true
        // deep-clone fidelity on legacy browsers must bring their own.
        return value
      }
    }
  }

  // ---- Array.prototype.at --------------------------------------------
  // Supported in Chromium 92+, Safari 15.4+. Patch the prototype only if
  // missing so V8/JSC fast paths remain intact on modern engines.
  if (typeof Array.prototype.at !== 'function') {
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Array.prototype, 'at', {
      value: function at(index) {
        // Spec: ToInteger, then add length if negative.
        const n = Math.trunc(Number(index)) || 0
        const len = this.length >>> 0
        const i = n < 0 ? len + n : n
        if (i < 0 || i >= len) return undefined
        return this[i]
      },
      writable: true,
      configurable: true,
    })
  }

  // ---- String.prototype.replaceAll -----------------------------------
  // Safari 13.1+ / Chromium 85+ ship this. For older engines, emulate
  // the string-search overload via split/join (no regex semantics).
  if (typeof String.prototype.replaceAll !== 'function') {
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(String.prototype, 'replaceAll', {
      value: function replaceAll(search, replacement) {
        // Per spec, a non-global RegExp must throw.
        if (search instanceof RegExp) {
          if (!search.flags.includes('g')) {
            throw new TypeError(
              'String.prototype.replaceAll called with a non-global RegExp argument',
            )
          }
          return this.replace(search, replacement)
        }
        // String search: split/join avoids regex escaping pitfalls.
        return this.split(String(search)).join(String(replacement))
      },
      writable: true,
      configurable: true,
    })
  }

  // ---- Object.hasOwn --------------------------------------------------
  // Chromium 93+, Safari 15.4+. Falls back to hasOwnProperty.call.
  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      value: function hasOwn(obj, key) {
        if (obj == null) {
          throw new TypeError('Cannot convert undefined or null to object')
        }
        return Object.prototype.hasOwnProperty.call(Object(obj), key)
      },
      writable: true,
      configurable: true,
    })
  }

  // ---- AbortSignal.timeout(ms) ---------------------------------------
  // Some fetch call sites use AbortSignal.timeout for per-request budgets.
  // Chromium 103+ / Safari 15.4+ ship it natively. Older engines may
  // still have AbortController, so we synthesise a signal from a timer.
  // If AbortController is itself missing we leave the property undefined
  // rather than ship a half-broken stub.
  if (typeof globalRef.AbortSignal !== 'undefined') {
    const AS = globalRef.AbortSignal
    if (typeof AS.timeout !== 'function' && typeof globalRef.AbortController === 'function') {
      try {
        Object.defineProperty(AS, 'timeout', {
          value: function timeout(ms) {
            const ctrl = new globalRef.AbortController()
            const delay = Math.max(0, Number(ms) || 0)
            // Use setTimeout from the global so test harnesses (jsdom etc.)
            // can still mock it.
            const handle = globalRef.setTimeout(() => {
              try {
                ctrl.abort(
                  // Match spec: abort reason is a TimeoutError DOMException
                  // when available; fall back to a plain Error.
                  typeof globalRef.DOMException === 'function'
                    ? new globalRef.DOMException('The operation timed out.', 'TimeoutError')
                    : new Error('TimeoutError'),
                )
              } catch (_e) {
                // ctrl.abort with reason isn't supported on the oldest
                // engines; abort without a reason as a last resort.
                try { ctrl.abort() } catch (_e2) { /* noop */ }
              }
            }, delay)
            // Best-effort: clear the timer once aborted to avoid leaks.
            const clear = () => globalRef.clearTimeout(handle)
            if (typeof ctrl.signal.addEventListener === 'function') {
              ctrl.signal.addEventListener('abort', clear, { once: true })
            }
            return ctrl.signal
          },
          writable: true,
          configurable: true,
        })
      } catch (_err) {
        // Some legacy engines reject defineProperty on built-ins; skip.
      }
    }
  }
})()
