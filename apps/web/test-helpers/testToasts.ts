import { toast, type ToastT } from "sonner";

export function testToasts() {
  const existing = new Set(toast.getHistory().map(({ id }) => id));
  const read = () => [
    ...new Map(
      toast
        .getToasts()
        .filter(
          (notice): notice is ToastT =>
            !("dismiss" in notice) && !existing.has(notice.id),
        )
        .map((notice) => [notice.id, notice]),
    ).values(),
  ];
  const clear = () => {
    for (const { id } of read()) toast.dismiss(id);
  };
  return { read, clear };
}
