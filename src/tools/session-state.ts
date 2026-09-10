/** Resolve session-owned state; omitted maps retain direct-call compatibility. */
export type SessionState = Map<string, unknown>
const legacyState: SessionState = new Map()
export function sessionStore<T>(sessionState: SessionState | undefined, key: string, create: () => T): T {
  const store = sessionState ?? legacyState
  const namespacedKey = `builtin:${key}`
  if (!store.has(namespacedKey)) store.set(namespacedKey, create())
  return store.get(namespacedKey) as T
}
