import { expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

test("the comment rail publishes once per open, resize, or close", () => {
  const { commentRailWidth, setCommentRailWidth } = useInboxStore.getState();
  const widths: Array<number | undefined> = [];
  const unsubscribe = useInboxStore.subscribe((state) =>
    widths.push(state.commentRailWidth.railFixture),
  );
  try {
    for (const width of [0, 320, 320, 380, 380, 0, 0])
      setCommentRailWidth("railFixture", width);
    expect(widths).toEqual([320, 380, undefined]);
  } finally {
    unsubscribe();
    useInboxStore.setState({ commentRailWidth });
  }
});
