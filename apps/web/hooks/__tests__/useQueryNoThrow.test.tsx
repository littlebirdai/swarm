import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { useQueryNoThrow } from "../useQueryNoThrow";

const machineQuery = makeFunctionReference<
  "query",
  { conversation_id: string },
  string
>("devices:getConversationMachine");
const metadataQuery = makeFunctionReference<
  "query",
  { conversation_id: string },
  string
>("conversations:getConversationWithMeta");
const args = { conversation_id: "abc" };
const missingFunction = new Error(
  "Could not find public function for 'devices:getConversationMachine'.",
);

function Probe({ skip }: { skip?: boolean }) {
  const { data, error } = useQueryNoThrow(machineQuery, skip ? "skip" : args);
  return <span data-error={error?.message ?? "no"}>{data ?? "fallback"}</span>;
}

describe("useQueryNoThrow", () => {
  test("a metadata timeout leaves cached conversation content renderable", async () => {
    const timeout = new Error(
      "Your request timed out performing too many system operations.",
    );
    function Conversation() {
      const { data, error } = useQueryNoThrow(metadataQuery, args);
      return (
        <article data-error={error?.message}>
          {data ?? "Cached transcript"}
          <textarea aria-label="Reply" />
        </article>
      );
    }
    const { container } = await mountWeb(<Conversation />, {
      setup: (backend) => backend.set(metadataQuery, timeout),
    });
    expect(container.textContent).toBe("Cached transcript");
    expect(
      container.querySelector('textarea[aria-label="Reply"]'),
    ).not.toBeNull();
    expect(container.querySelector("article")?.dataset.error).toContain(
      timeout.message,
    );
  });

  test("a missing backend function renders instead of throwing", async () => {
    const { container } = await mountWeb(<Probe />, {
      setup: (backend) => backend.set(machineQuery, missingFunction),
    });
    expect(container.textContent).toBe("fallback");
    expect(container.querySelector("span")?.dataset.error).toContain(
      missingFunction.message,
    );
  });

  test("a resolved value passes straight through", async () => {
    const { container } = await mountWeb(<Probe />, {
      setup: (backend) => backend.set(machineQuery, "a-machine"),
    });
    expect(container.textContent).toBe("a-machine");
    expect(container.querySelector("span")?.dataset.error).toBe("no");
  });

  test("loading is undefined data with no error", async () => {
    const { container, backend } = await mountWeb(<Probe />, {
      setup: (backend) => backend.set(machineQuery, pending),
    });
    expect(backend.queryRequests).toEqual([
      { name: "devices:getConversationMachine", args },
    ]);
    expect(container.textContent).toBe("fallback");
    expect(container.querySelector("span")?.dataset.error).toBe("no");
  });

  test("skip subscribes to nothing", async () => {
    const { container, backend } = await mountWeb(<Probe skip />);
    expect(backend.queryRequests).toEqual([]);
    expect(container.textContent).toBe("fallback");
    expect(container.querySelector("span")?.dataset.error).toBe("no");
  });
});
