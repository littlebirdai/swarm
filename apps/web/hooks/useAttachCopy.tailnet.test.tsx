import { describe, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { SessionMachine } from "../components/tmuxAttach";
import { mountWeb } from "../test-helpers/mountWeb";
import { useInboxStore } from "../store/inboxStore";
import { useAttachCopy } from "./useAttachCopy";

const MINE: SessionMachine = {
  device_id: "box",
  label: "Linux - nose",
  platform: "linux",
  is_remote: false,
  is_mine: true,
  ssh_host: null,
};
function Probe() {
  return <>{useAttachCopy("cc-x", "jx7conv").attach}</>;
}
const device = (
  device_id: string,
  tailnet?: { name: string; tailnet?: string },
) => ({
  device_id,
  label: device_id,
  platform: "linux",
  is_remote: false,
  last_seen: 1,
  online: true,
  ...(tailnet
    ? { tailnet: { ip: "100.64.0.9", tailnet: "tail1234.ts.net", ...tailnet } }
    : {}),
});
const roster = (
  tailnet?: { name: string },
  viewerTailnet: string | null = "tail1234.ts.net",
) => [
  device("box", tailnet),
  device(
    "laptop",
    viewerTailnet
      ? { name: `laptop.${viewerTailnet}.`, tailnet: viewerTailnet }
      : undefined,
  ),
];
const viewer = { _id: "u1" };

async function attachFor({
  machine = MINE,
  devices = roster({ name: "nose.tail1234.ts.net." }),
  localDevice = { viewer: viewer._id, deviceId: "laptop" },
}: {
  machine?: SessionMachine;
  devices?: ReturnType<typeof roster>;
  localDevice?: { viewer: string; deviceId: string } | null;
} = {}) {
  const { container, backend } = await mountWeb(<Probe />, {
    setup: (backend, store) => {
      store.syncTable("currentUser", viewer);
      store.setMachineRoster(devices);
      useInboxStore.setState({ localDevice });
      backend.set(api.devices.getConversationMachine, {
        ...machine,
        last_seen: 1,
        via_bot: false,
        wsl_distro: null,
      });
    },
  });
  expect(backend.queryRequests).toEqual([
    {
      name: "devices:getConversationMachine",
      args: { conversation_id: "jx7conv" },
    },
  ]);
  return container.textContent;
}

describe("useAttachCopy reaches another of your machines over its tailnet", async () => {
  test("no ssh host, on a tailnet, viewed from another machine on that tailnet: ssh to the MagicDNS short name", async () => {
    expect(await attachFor()).toStartWith("ssh nose -t ");
  });

  test("viewed from a machine on another tailnet: ssh to the full MagicDNS name", async () => {
    expect(
      await attachFor({
        devices: roster({ name: "nose.tail1234.ts.net." }, "tail9999.ts.net"),
      }),
    ).toStartWith("ssh nose.tail1234.ts.net -t ");
  });

  test("viewed from a machine with no tailnet: ssh to the full MagicDNS name", async () => {
    expect(
      await attachFor({
        devices: roster({ name: "nose.tail1234.ts.net." }, null),
      }),
    ).toStartWith("ssh nose.tail1234.ts.net -t ");
  });

  test("this window's own machine is not known yet: the local attach, since the pane may be right here", async () => {
    expect(await attachFor({ localDevice: null })).toStartWith("tmux -L");
  });

  test("the pane is on this window's own machine: the local attach", async () => {
    expect(
      await attachFor({ localDevice: { viewer: viewer._id, deviceId: "box" } }),
    ).toStartWith("tmux -L");
  });

  test("the machine reports no tailnet: the local attach", async () => {
    expect(await attachFor({ devices: roster() })).toStartWith("tmux -L");
  });

  test("the pane is on this window's own machine and it has an ssh host: the local attach, no ssh to itself", async () => {
    expect(
      await attachFor({
        machine: { ...MINE, ssh_host: "me@nose.lan" },
        localDevice: { viewer: viewer._id, deviceId: "box" },
      }),
    ).toStartWith("tmux -L");
  });

  test("an ssh host the person set wins over the tailnet", async () => {
    expect(
      await attachFor({ machine: { ...MINE, ssh_host: "me@nose.lan" } }),
    ).toStartWith("ssh me@nose.lan -t ");
  });
});
