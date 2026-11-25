export type StatusStamps = {
  agent_status?: string;
  agent_status_updated_at?: number;
  agent_status_write_at?: number;
};

// A status write older than the last applied one, or a different status at the
// same instant, loses.
export function statusWriteIsStale(
  session: StatusStamps,
  status: string,
  clientTs?: number,
): boolean {
  const previous =
    session.agent_status_write_at ?? session.agent_status_updated_at;
  return (
    clientTs !== undefined &&
    previous !== undefined &&
    (clientTs < previous ||
      (clientTs === previous && status !== session.agent_status))
  );
}
