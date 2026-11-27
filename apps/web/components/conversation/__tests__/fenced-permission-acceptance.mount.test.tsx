import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { act } from "react";
import { PermissionCard, PermissionStackView } from "../../permission-card";
import { ModernPermissionStack } from "../ModernPermissionStack";
import { useSyncPendingPermissions } from "../../../hooks/useSyncPendingPermissions";
import { useInboxStore } from "../../../store/inboxStore";
import { mountWeb } from "../../../test-helpers/mountWeb";

const conversation = "a".repeat(32) as Id<"conversations">;
const lease = "b".repeat(32) as Id<"run_leases">;
const permissionId = "c".repeat(32) as Id<"pending_permissions">;
const prompt = "1:app-server:string:approval";
const address = {
  _id: JSON.stringify([lease, "turn", prompt]),
  conversation_id: conversation,
  lease_id: lease,
  turn_id: "turn",
  run: 1,
  prompt_id: prompt,
  kind: "permission" as const,
  questions: [],
};
const permission = {
  _id: permissionId,
  _creationTime: 1,
  session_id: "provider-session",
  arguments_preview: "",
  conversation_id: conversation,
  status: "pending" as const,
  tool_name: "Read",
  fenced_prompt_id: prompt,
  fenced_prompt_turn_id: "turn",
  created_at: 1,
};

function PendingPermission() {
  useSyncPendingPermissions(conversation);
  const row = useInboxStore((state) => state.pendingPermissions[permissionId]);
  return row ? <PermissionCard permission={row} /> : null;
}

test.each(["acknowledgement", "prompt removal"] as const)(
  "an accepted permission stays sent while its request is pending (%s first)",
  async (first) => {
    const gate = Promise.withResolvers<null>();
    const web = await mountWeb(<PendingPermission />, {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(api.permissions.getPendingPermissions, [permission]);
        backend.set(api.permissions.getFencedPromptFeed, {
          prompts: [address],
          turn: null,
        });
        backend.mutation(api.dispatch.dispatch, () => gate.promise);
      },
    });
    const dropPrompt = () =>
      web.backend.set(api.permissions.getFencedPromptFeed, {
        prompts: [],
        turn: null,
      });
    try {
      const approve = [...web.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Approve",
      );
      expect(approve).toBeDefined();
      await act(async () => approve?.click());
      if (first === "prompt removal") await act(async () => dropPrompt());
      await act(async () => gate.resolve(null));
      expect(web.container.textContent).toContain("Permission decision sent");
      if (first === "acknowledgement") await act(async () => dropPrompt());
      expect(web.container.textContent).toContain("Permission decision sent");
      expect(
        web.store.getState().fencedPromptAddresses[address._id]?.accepted,
      ).toBe(true);
      await act(async () =>
        web.backend.set(api.permissions.getPendingPermissions, []),
      );
      expect(web.container.textContent).not.toContain(
        "Permission decision sent",
      );
      expect(
        web.store.getState().fencedPromptAddresses[address._id],
      ).toBeUndefined();
    } finally {
      gate.resolve(null);
      await web.close();
    }
  },
);

test.each([
  ["classic", PermissionStackView],
  ["modern", ModernPermissionStack],
] as const)(
  "bulk permission actions are disabled when every %s row is in flight",
  async (_style, Stack) => {
    const pending = [permission, { ...permission, _id: "other" }];
    const web = await mountWeb(
      <Stack
        pending={pending}
        inflight={new Set(pending.map(({ _id }) => _id))}
        onApprove={() => {}}
        onDeny={() => {}}
        onApproveAll={() => {}}
        onDenyAll={() => {}}
      />,
    );
    try {
      for (const label of ["Approve all", "Deny all"]) {
        const button = [...web.container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === label,
        );
        expect(button?.disabled).toBe(true);
      }
    } finally {
      await web.close();
    }
  },
);
