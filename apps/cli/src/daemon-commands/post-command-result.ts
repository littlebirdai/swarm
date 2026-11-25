/** Report a command's outcome to the server (a later report replaces an earlier one). */
export async function postCommandResult(
  siteUrl: string,
  apiToken: string,
  commandId: string,
  result?: string,
  error?: string,
): Promise<void> {
  await fetch(`${siteUrl}/cli/command-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: apiToken,
      command_id: commandId,
      result,
      error,
    }),
  });
}
