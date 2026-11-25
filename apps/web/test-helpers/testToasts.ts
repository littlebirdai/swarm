import { afterEach, spyOn } from "bun:test";
import { act } from "react";
import * as sonner from "sonner";
import type { ToastT } from "sonner";

type ToastEvent = {
  event: "show" | "update" | "dismiss";
  id: ToastT["id"];
  kind: NonNullable<ToastT["type"]>;
  title: ToastT["title"];
};

let observation: ReturnType<typeof observeToasts> | undefined;

afterEach(() => {
  observation?.restore();
  observation = undefined;
});

function observeToasts() {
  const real = sonner.toast;
  const log: ToastEvent[] = [];
  const active = new Map<ToastT["id"], ToastEvent>();
  const publish = (
    id: ToastT["id"],
    kind: ToastEvent["kind"],
    title: ToastEvent["title"],
  ) => {
    const entry = {
      event: active.has(id) ? ("update" as const) : ("show" as const),
      id,
      kind,
      title,
    };
    active.set(id, entry);
    log.push(entry);
    return id;
  };
  const replacement = Object.assign(
    (...args: Parameters<typeof real>) =>
      publish(real(...args), "normal", args[0]),
    real,
    {
      dismiss(id?: ToastT["id"]) {
        const result = real.dismiss(id);
        const ids = id === undefined ? [...active.keys()] : [id];
        for (const key of ids) {
          const entry = active.get(key);
          if (!entry) continue;
          log.push({ ...entry, event: "dismiss" });
          active.delete(key);
        }
        return result;
      },
      custom: (...args: Parameters<typeof real.custom>) =>
        publish(real.custom(...args), "normal", undefined),
    },
  );
  for (const kind of [
    "success",
    "info",
    "warning",
    "error",
    "message",
    "loading",
  ] as const) {
    replacement[kind] = (title, options) =>
      publish(
        real[kind](title, options),
        kind === "message" ? "normal" : kind,
        title,
      );
  }
  const wrapped = spyOn(sonner, "toast").mockImplementation(replacement);
  Object.assign(wrapped, replacement);
  return { log, restore: () => wrapped.mockRestore() };
}

export function testToasts() {
  const { log } = (observation ??= observeToasts());
  const start = log.length;
  const events = () => log.slice(start);
  const read = () => {
    const ids = new Set(events().map(({ id }) => id));
    return [
      ...new Map(
        sonner.toast
          .getToasts()
          .filter(
            (notice): notice is ToastT =>
              !("dismiss" in notice) && ids.has(notice.id),
          )
          .map((notice) => [notice.id, notice]),
      ).values(),
    ];
  };
  const clear = () =>
    act(async () => {
      for (const { id } of read()) sonner.toast.dismiss(id);
    });
  return { read, events, clear };
}
