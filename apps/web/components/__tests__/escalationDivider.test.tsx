import { describe, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import {
  classifyUserMessage,
  FOLD_KEPT_USER_KINDS,
  isStickyWorthy,
} from "../conversation/classify";
import { EscalationDivider } from "../conversation/blocks/systemBlocks";
import { IdentityPrefsOverride } from "../../hooks/useIdentityPrefs";
import { DEFAULT_IDENTITY_PREFS } from "../../lib/sessionIdentity";

const wire = [
  '<session-escalation move="handed" by="role" role="or-8" handle="calling" name="Calling" avatar="fox" session="jx7abcd" title="Market growth mandate" to="Ashot" at="1790000000000">',
  "how a market is **filled** is yours to call\n\n- 40 seats now\n- or 80 after the pilot",
  "</session-escalation>",
].join("\n");
const backWire =
  '<session-escalation move="back" by="person" role="or-8" handle="calling" name="Calling" session="jx7abcd" to="Ashot" at="1">\n\n</session-escalation>';
const mount = (node: React.ReactNode) =>
  mountWeb(
    <IdentityPrefsOverride.Provider value={DEFAULT_IDENTITY_PREFS}>
      {node}
    </IdentityPrefsOverride.Provider>,
    { setup: (backend) => backend.set(api.conversations.webGet, pending) },
  );

describe("escalation divider", () => {
  test("classifies as its own kind, kept when folded, never sticky", () => {
    const kind = classifyUserMessage({
      _id: "m1",
      role: "user",
      content: wire,
      timestamp: 1,
    });
    expect(kind.kind).toBe("session_escalation");
    if (kind.kind !== "session_escalation") throw new Error("kind");
    expect(kind.escalation.role.handle).toBe("calling");
    expect(FOLD_KEPT_USER_KINDS.has(kind.kind)).toBe(false);
    expect(isStickyWorthy(kind)).toBe(false);
  });

  test("in the child's thread: the face, 'this session', the whole line as markdown, no pill", async () => {
    const kind = classifyUserMessage({
      _id: "m1",
      role: "user",
      content: wire,
      timestamp: 1,
    });
    if (kind.kind !== "session_escalation") throw new Error("kind");
    const { container } = await mount(
      <EscalationDivider
        escalation={kind.escalation}
        conversationShortId="jx7abcd"
        timestamp={1_790_000_000_000}
      />,
    );
    expect(container.innerHTML).toContain(
      'data-switch-divider="escalation-handed"',
    );
    expect(container.innerHTML).toContain(
      "@calling handed this session to Ashot",
    );
    expect(container.innerHTML).toContain("<strong>filled</strong>");
    expect(container.innerHTML).toContain("<li>40 seats now</li>");
    expect(container.innerHTML).toContain("or 80 after the pilot");
    expect(container.innerHTML).toMatch(/<img[^>]*alt="Calling"/);
    expect(container.innerHTML).not.toContain(">jx7abcd<");
  });

  test("in the role's thread: the session is named by its pill; a hand back has no body", async () => {
    const kind = classifyUserMessage({
      _id: "m1",
      role: "user",
      content: wire,
      timestamp: 1,
    });
    if (kind.kind !== "session_escalation") throw new Error("kind");
    const { container, rerender } = await mount(
      <EscalationDivider
        escalation={kind.escalation}
        conversationShortId="jx7rolee"
        timestamp={1_790_000_000_000}
      />,
    );
    expect(container.innerHTML).toContain("@calling handed jx7abcd to Ashot");
    expect(container.innerHTML).toContain("jx7abcd");
    const back = classifyUserMessage({
      _id: "m2",
      role: "user",
      content: backWire,
      timestamp: 2,
    });
    if (back.kind !== "session_escalation") throw new Error("kind");
    await rerender(
      <IdentityPrefsOverride.Provider value={DEFAULT_IDENTITY_PREFS}>
        <EscalationDivider
          escalation={back.escalation}
          conversationShortId="jx7abcd"
          timestamp={2}
        />
      </IdentityPrefsOverride.Provider>,
    );
    expect(container.innerHTML).toContain("this session is back with @calling");
    expect(container.innerHTML).not.toContain("data-switch-divider-body");
  });
});
