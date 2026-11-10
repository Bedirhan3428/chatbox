type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    (this.listeners[event] ??= new Set()).add(fn);
    return () => this.listeners[event]?.delete(fn);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event]?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.warn(`[emitter] ${String(event)} listener failed`, e);
      }
    });
  }

  removeAllListeners(): void {
    this.listeners = {};
  }
}
