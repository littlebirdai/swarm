import { expect, test } from "bun:test";
import { Profiler, act } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { useConversationMessages } from "../use-conversation-messages";
import { CardNode } from "../../components/sessionMap/map-card";
import { mountWeb } from "../../test-helpers/mountWeb";

const id = "local-heartbeat-wake";
const heartbeat = 1_000;
const facts = (at: number) => ({
  last_heartbeat: at,
  liveness_lease_end: at + HEARTBEAT_ALIVE_MS,
  updated_at: at,
  message_count: 1,
});

function Conversation() {
  const { conversation } = useConversationMessages(id);
  return <span>{conversation?.title}</span>;
}

function MapStage() {
  return (
    <ReactFlowProvider>
      <CardNode
        id={id}
        data={{
          s: {
            id,
            title: "Heartbeat wake",
            state: "working",
            updated_at: heartbeat,
            agent_type: "claude_code",
            repo: "",
            workers: 0,
          },
          dim: false,
        }}
        selected={false}
        dragging={false}
        draggable={false}
        selectable={false}
        deletable={false}
        zIndex={0}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  );
}

test.each([
  ["conversation", Conversation],
  ["map stage", MapStage],
] as const)("%s stays asleep on a heartbeat-only push", async (name, View) => {
  let commits = 0;
  const ui = await mountWeb(
    <Profiler id={name} onRender={() => commits++}>
      <View />
    </Profiler>,
    {
      clock: true,
      setup: (_, store) => {
        store.syncTable("sessions", [
          {
            _id: id,
            session_id: id,
            agent_type: "claude_code",
            message_count: 1,
            updated_at: heartbeat,
            title: "Heartbeat wake",
          },
        ]);
        store.applyInboxLivenessPayload("mine", { [id]: facts(heartbeat) });
      },
    },
  );
  if (name === "map stage") {
    expect(
      ui.container.querySelector("[data-map-level='close']"),
    ).not.toBeNull();
  }
  const initial = commits;
  expect(initial).toBeGreaterThan(0);

  await act(async () => {
    ui.store.getState().applyInboxLivenessPayload("mine", {
      [id]: facts(heartbeat + 30_000),
    });
  });
  expect(commits).toBe(initial);

  await act(async () => {
    ui.store.getState().applyInboxLivenessPayload("mine", {
      [id]: { ...facts(heartbeat + 30_000), message_count: 2 },
    });
  });
  expect(commits).toBeGreaterThan(initial);
});
