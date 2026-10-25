// WXT auto-imports these globals at build time. In tests, entrypoint modules are
// imported directly, so provide shims that return the definition without running it.
type AnyFn = (...args: unknown[]) => unknown

;(globalThis as unknown as { defineBackground: AnyFn }).defineBackground = (arg: unknown) =>
	typeof arg === 'function' ? { main: arg } : arg
;(globalThis as unknown as { defineContentScript: AnyFn }).defineContentScript = (arg: unknown) => arg
