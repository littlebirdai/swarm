import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import {
  selectNavCollapsed,
  selectSessionRailOpen,
} from "../slices/workspace-slice";

describe("switchTab — each tab freezes and restores its own frame", () => {
  const tabA = { id: "tab_a", title: "inbox", path: "/inbox", createdAt: 1 };
  const tabB = { id: "tab_b", title: "chat", path: "/chat", createdAt: 2 };

  beforeEach(() => {
    useInboxStore.setState({
      tabs: [tabA, tabB],
      activeTabId: "tab_a",
      sidePanelSessionId: null,
    });
  });

  it("restores each tab's frame — rail state, widths, nav collapse, rail subject", () => {
    // Tab A's frame: rail open at 342, nav expanded, rail on conv-a.
    const st = useInboxStore.getState();
    if (!selectSessionRailOpen(st)) st.toggleSidePanel();
    st.wsSetSize("context", 342);
    st.setNavCollapsed(false);
    useInboxStore.setState({ sidePanelSessionId: "conv-a" });
    const frameA = useInboxStore.getState().workspace;

    useInboxStore.getState().switchTab("tab_b");
    // B has no snapshot yet: it inherits A's frame untouched (same ref)…
    let s = useInboxStore.getState();
    expect(s.workspace).toBe(frameA);
    // …then diverges: rail closed, nav collapsed, narrower context.
    s.toggleSidePanel();
    useInboxStore.getState().setNavCollapsed(true);
    useInboxStore.getState().wsSetSize("context", 18);
    useInboxStore.setState({ sidePanelSessionId: null });

    useInboxStore.getState().switchTab("tab_a");
    s = useInboxStore.getState();
    expect(selectSessionRailOpen(s)).toBe(true);
    expect(s.workspace.context.size).toBe(342);
    expect(selectNavCollapsed(s)).toBe(false);
    expect(s.sidePanelSessionId).toBe("conv-a");

    useInboxStore.getState().switchTab("tab_b");
    s = useInboxStore.getState();
    expect(selectSessionRailOpen(s)).toBe(false);
    expect(selectNavCollapsed(s)).toBe(true);
    expect(s.workspace.context.size).toBe(18);
    expect(s.sidePanelSessionId).toBe(null);
  });

  it("a malformed legacy snapshot is inert — no slot may go missing", () => {
    // Old clients persisted partial shapes ({ context: { presentation } },
    // no pane key). Adopting one wholesale would leave workspace slots
    // undefined and crash the layout; such slots must be skipped.
    const legacy = {
      ...tabB,
      workspace: { context: { presentation: "split" } },
    } as any;
    useInboxStore.setState({ tabs: [tabA, legacy], activeTabId: "tab_a" });
    const before = useInboxStore.getState().workspace;

    useInboxStore.getState().switchTab("tab_b");

    expect(useInboxStore.getState().workspace).toBe(before);
  });

  it("closing the active tab restores the promoted tab's frame", () => {
    const st = useInboxStore.getState();
    if (!selectSessionRailOpen(st)) st.toggleSidePanel();
    st.wsSetSize("context", 342);
    useInboxStore.setState({ sidePanelSessionId: "conv-a" });

    // Switch to B (stamps A), close B while its rail is shut.
    useInboxStore.getState().switchTab("tab_b");
    useInboxStore.getState().toggleSidePanel();
    useInboxStore.getState().closeTab("tab_b");

    const s = useInboxStore.getState();
    expect(s.activeTabId).toBe("tab_a");
    expect(selectSessionRailOpen(s)).toBe(true);
    expect(s.workspace.context.size).toBe(342);
    expect(s.sidePanelSessionId).toBe("conv-a");
  });
});
