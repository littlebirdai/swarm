import { useInboxStore } from "./inboxStore";

export function observeDesktopStoreReads(
  keys: Iterable<string>,
  onRead: (key: string, caller: string) => void,
): () => void {
  const renderer = globalThis.window;
  let restore: (() => void) | undefined;
  let current: ReturnType<typeof useInboxStore.getState> | undefined;
  const observe = (state: ReturnType<typeof useInboxStore.getState>) => {
    if (state === current) return;
    restore?.();
    current = state;
    const properties: PropertyDescriptorMap = {};
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(state, key);
      if (!property?.configurable || !("value" in property)) continue;
      properties[key] = property;
      Object.defineProperty(state, key, {
        configurable: true,
        enumerable: property.enumerable,
        get() {
          if (globalThis.window !== renderer) return property.value;
          const frames = new Error().stack?.split("\n").slice(2) ?? [];
          const source = /\/(components|hooks|app|src|lib|store)\/[^ )]+/;
          const matches = frames.map((frame) =>
            frame.includes("/node_modules/")
              ? undefined
              : frame.match(source)?.[0],
          );
          const caller = matches[0];
          if (
            caller &&
            (!caller.startsWith("/store/") ||
              matches.some(
                (frame) =>
                  frame && /^\/(components|hooks|app|src|lib)\//.test(frame),
              ))
          )
            onRead(key, caller.slice(1));
          return property.value;
        },
      });
    }
    restore = () => Object.defineProperties(state, properties);
  };
  const getState = useInboxStore.getState;
  useInboxStore.getState = () => {
    const state = getState();
    observe(state);
    return state;
  };
  observe(getState());
  const unsubscribe = useInboxStore.subscribe(observe);
  return () => {
    useInboxStore.getState = getState;
    unsubscribe();
    restore?.();
  };
}
