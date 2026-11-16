// A value outside React with change listeners, for `useSyncExternalStore`.

export interface Store<T> {
  get(): T;
  /** Notifies only when the value is not `same` as the current one. */
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T, same: (a: T, b: T) => boolean = Object.is): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (same(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
