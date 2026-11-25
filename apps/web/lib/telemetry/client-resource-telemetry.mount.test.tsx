import { CODECAST_EVENTS } from "@codecast/analytics";
import { validateEvent } from "@platform/analytics/catalog";
import { expect, spyOn, test } from "bun:test";
import { storageTimings } from "../../store/persistence/storage-timings";
import { TestSocket } from "../../test-helpers/convexWire";
import { mountWeb } from "../../test-helpers/mountWeb";
import * as analytics from "../analytics";
import { ClientResourceTelemetry } from "./client-resource-telemetry";

test("emits persistence timings in the scheduled resource event", async () => {
  const track = spyOn(analytics, "track").mockImplementation(() => {});
  const sendFrame = TestSocket.prototype.send;
  let socket: TestSocket | undefined;
  const send = spyOn(TestSocket.prototype, "send").mockImplementation(function (
    this: TestSocket,
    data: string,
  ) {
    socket = this;
    sendFrame.call(this, data);
  });
  storageTimings.take();
  try {
    const web = await mountWeb(<ClientResourceTelemetry />, {
      authenticated: true,
      clock: true,
    });
    try {
      storageTimings.recordBoot("critical", "sessions", 401);
      storageTimings.recordWrite("put", 12);
      await web.clock!.advance(30_000);
      socket!.reply({ type: "Ping" });
      await web.clock!.advance(31_000);
      const call = track.mock.calls.find(
        ([name]) => name === "client_resource_report",
      );
      expect(call?.[1]).toMatchObject({
        idb_boot_critical_ms: { sessions: 401 },
        idb_write_count: { put: 1 },
        idb_write_p50_ms: { put: 12 },
        idb_write_p95_ms: { put: 12 },
      });
      expect(
        validateEvent(CODECAST_EVENTS, "client_resource_report", call?.[1]).ok,
      ).toBe(true);
    } finally {
      await web.close();
    }
  } finally {
    send.mockRestore();
    track.mockRestore();
    storageTimings.take();
  }
});
