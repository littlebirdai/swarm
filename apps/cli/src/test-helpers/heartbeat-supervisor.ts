import { startMachine } from "@codecast/edge-supervisor";
import {
  closeEdgeSupervisorForTests,
  heartbeatFlushHostForTests,
  setEdgeMachineForTests,
} from "../daemon.js";

export async function startTestHeartbeatSupervisor(): Promise<
  () => Promise<void>
> {
  const machine = await startMachine({
    log: () => {},
    heartbeatFlush: heartbeatFlushHostForTests(),
  });
  setEdgeMachineForTests(machine);
  return async () => {
    await closeEdgeSupervisorForTests();
    setEdgeMachineForTests(undefined);
  };
}

export async function withTestHeartbeatSupervisor<T>(
  run: () => Promise<T>,
): Promise<T> {
  const stop = await startTestHeartbeatSupervisor();
  try {
    return await run();
  } finally {
    await stop();
  }
}
