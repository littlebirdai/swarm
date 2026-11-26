import { expect } from "bun:test";
import { api } from "../convex/_generated/api";
import { asUser } from "./database.testkit";
import { deviceId, terminalWatchFixture } from "./terminal-watch.testkit";

const typing = api.terminalInput;

export async function terminalTypingFixture(
  limits?: Parameters<typeof terminalWatchFixture>[0],
) {
  const world = await terminalWatchFixture(limits);
  const { t, owner, viewer, args, ids, start, token } = world;
  const { lease } = await start();
  const pane = { ...args, pane_instance: 1 };
  const machine = {
    ...args,
    api_token: token,
    device_id: deviceId,
    agent_started_at: 100,
  };
  const second = asUser(t, ids.secondViewer);
  await second.mutation(api.terminalWatch.watch, { ...lease, renew: false });
  const report = (
    pane_instance: number,
    observation: "started" | "ended" = "started",
  ) =>
    t.mutation(typing.cliReportPane, {
      ...machine,
      pane_instance,
      observation,
      watch_pane_instance: "pane-generation",
    });
  const grant = (user_id = ids.viewer, enabled = true) =>
    owner.mutation(typing.setTypingGrant, { ...args, user_id, enabled });
  const focus = (
    account = viewer,
    request_id = "initial",
    expected_token = 0,
    pane_instance = 1,
  ) =>
    account.mutation(typing.focus, {
      ...pane,
      pane_instance,
      request_id,
      expected_token,
    });
  const poll = (
    sequence?: number,
    acceptedToken: number | null = 1,
    pane_instance = 1,
  ) =>
    t.mutation(typing.cliPoll, {
      ...machine,
      pane_instance,
      ...(sequence === undefined
        ? {}
        : { ack: { sequence, token: acceptedToken } }),
    });
  const send = (
    account = viewer,
    leaseToken = 1,
    pane_instance = 1,
    data = "61",
  ) =>
    account.mutation(typing.send, {
      ...pane,
      pane_instance,
      token: leaseToken,
      data,
    });
  const grantAndFocus = async () => {
    expect(await grant()).toBe(true);
    expect(await focus()).toMatchObject({ status: "held", token: 1 });
    const response = await poll();
    if (response.status !== "ok") throw new Error("Expected a control message");
    const { control } = response;
    expect(control).toMatchObject({ token: 1, pane_instance: 1 });
    return control;
  };
  return {
    ...world,
    lease,
    second,
    pane,
    machine,
    report,
    grant,
    focus,
    poll,
    send,
    grantAndFocus,
  };
}
