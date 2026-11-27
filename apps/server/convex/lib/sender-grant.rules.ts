export const SENDER_GRANT_REPORT_FLAG = "SWARM_SENDER_GRANT_REPORT";

export type SenderGrantMachineKind = "personal" | "team" | "hosted" | "unknown";

export type SenderGrantSenderKind =
  | "owner"
  | "teammate"
  | "link_visitor"
  | "agent";

export type SenderGrantReason =
  | "owner"
  | "team_machine"
  | "hosted_machine"
  | "grant_present"
  | "personal_machine_no_grant"
  | "unknown_machine";

export interface SenderGrantDecisionInput {
  machineKind: SenderGrantMachineKind;
  senderIsOwner: boolean;
  senderKind: SenderGrantSenderKind;
  hasGrant: boolean;
}

export interface SenderGrantDecision {
  needsGrant: boolean;
  shouldReport: boolean;
  senderKind: SenderGrantSenderKind;
  reason: SenderGrantReason;
}

export function senderGrantReportEnabled(): boolean {
  return process.env[SENDER_GRANT_REPORT_FLAG] === "1";
}

export function decideSenderGrant(
  input: SenderGrantDecisionInput,
): SenderGrantDecision {
  if (input.senderIsOwner) {
    return {
      needsGrant: false,
      shouldReport: false,
      senderKind: input.senderKind,
      reason: "owner",
    };
  }
  if (input.machineKind === "hosted") {
    return {
      needsGrant: false,
      shouldReport: false,
      senderKind: input.senderKind,
      reason: "hosted_machine",
    };
  }
  if (input.machineKind === "team") {
    return {
      needsGrant: false,
      shouldReport: false,
      senderKind: input.senderKind,
      reason: "team_machine",
    };
  }
  const reportableSender =
    input.senderKind === "teammate" || input.senderKind === "agent";
  if (input.machineKind === "unknown") {
    return {
      needsGrant: false,
      shouldReport: reportableSender,
      senderKind: input.senderKind,
      reason: "unknown_machine",
    };
  }
  if (input.hasGrant) {
    return {
      needsGrant: false,
      shouldReport: false,
      senderKind: input.senderKind,
      reason: "grant_present",
    };
  }
  return {
    needsGrant: true,
    shouldReport: reportableSender,
    senderKind: input.senderKind,
    reason: "personal_machine_no_grant",
  };
}
