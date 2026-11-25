import type { ProviderEvent, ProviderEventIterator } from "../src";

type EventResult = IteratorResult<ProviderEvent, undefined>;

export function fakeEventStream(capacity: number) {
  const done = { done: true, value: undefined } as const;
  const buffer: ProviderEvent[] = [];
  const backpressure = Promise.withResolvers<void>();
  let room = Promise.withResolvers<void>();
  let reader: ReturnType<typeof Promise.withResolvers<EventResult>> | undefined;
  let ended = false;
  let defect: Error | undefined;

  function end(error?: Error) {
    ended = true;
    defect = error;
    if (error) {
      reader?.reject(error);
    } else {
      reader?.resolve(done);
    }
    reader = undefined;
    room.resolve();
  }

  const iterator: ProviderEventIterator = {
    async next() {
      const value = buffer.shift();
      if (value) {
        room.resolve();
        room = Promise.withResolvers<void>();
        return { done: false, value };
      }
      if (defect) throw defect;
      if (ended) return done;
      reader = Promise.withResolvers<EventResult>();
      return reader.promise;
    },
    async return() {
      buffer.length = 0;
      end();
      return done;
    },
  };

  return {
    events: { [Symbol.asyncIterator]: () => iterator },
    end,
    discard: () => iterator.return(),
    async emit(event: ProviderEvent) {
      while (buffer.length >= capacity && !ended) {
        backpressure.resolve();
        await room.promise;
      }
      if (ended) return;
      if (reader) {
        reader.resolve({ done: false, value: event });
        reader = undefined;
      } else {
        buffer.push(event);
      }
    },
    waitForBackpressure: () => backpressure.promise,
  };
}
