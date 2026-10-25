/** Minimal typed event emitter. */
export class Emitter<E extends Record<string, unknown>> {
  private handlers: { [K in keyof E]?: Set<(payload: E[K]) => void> } = {};

  on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
    const set = (this.handlers[event] ??= new Set());
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    this.handlers[event]?.forEach((h) => h(payload));
  }

  hasListeners(event: keyof E): boolean {
    return (this.handlers[event]?.size ?? 0) > 0;
  }

  clear(): void {
    this.handlers = {};
  }
}
