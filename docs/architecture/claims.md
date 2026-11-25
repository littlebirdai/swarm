# Baton and terminal claims

The server keeps at most two claim rows per conversation, one baton and one terminal typing lease. Each successful grant adds 1 to that row's token. The baton lease lasts 30 seconds and the terminal lease lasts 20 seconds. The server clock sets the deadline. Results give the remaining duration.

Callers check access, grants, and revoke authority. Every terminal use must name the pane instance that the caller resolves from server state. Pane instances are positive safe integers that increase across runs. A claim for an older pane returns `wrong_pane` and leaves the row intact. A fresh request for a higher pane instance clears the holder and returns `pane_changed` with the previous token. A separate request can then claim the new pane and advance the token.

A new request uses a fresh ID and the token from `readClaimToken(db, resource)`. Keep both values on retry. The recorded ID returns the same live lease to its original holder, even if the expected token differs. An inactive request cannot grant a lease. A different holder gets `stale_request`. Once a newer grant replaces the receipt, the old expected token blocks delayed retries.

A lone driver uses the implied right when the row is free. The lone request has no request ID or expected token. A live row grants its holder the right and blocks everyone else. On the first request from a second sender, grant the starter's lease and queue the sender's message in the same mutation. The caller owns that queue and the delivery fence.

Put each protected write inside `withHeldClaim`. Its callback receives the same mutation context. A refusal skips the callback. Renew, release, and revoke also check the holder, token, deadline, and pane where applicable.

Keep expired and cleared rows while the conversation exists, so tokens survive releases and pane restarts. Deleting the conversation deletes its claim rows. A regulated team purge keeps both claims until the transaction that deletes the conversation. Account deletion clears that user's holder and request fields on surviving conversations and preserves the token and pane number. Its ID is not used again, and callers must refuse a claim for a conversation that does not exist. The server-only rows store lease metadata and a non-secret request receipt.

## Model trace

| Model           | Server actions and invariants                                                                                                                                                                                                      | Verification                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| LoneJoin        | `claim` implements `Right`, `Serve`, `ZeroWritesAlone`, and `GoneHolderFreesBaton`.                                                                                                                                                | Second sender, live baton, and released-row cases                     |
| CoSteer         | `claim` and `release` implement `Take`, `Release`, and `OneSteerer`. `withHeldClaim` guards `Start`. The caller owns prompt, queue, and in-flight delivery rules.                                                                  | Concurrent claims and holder-only write cases                         |
| FencedTakeover  | `revoke` fences the old holder at `Request`. `withHeldClaim` gates `SrvStart`. The caller waits for delivery settlement or machine fence acknowledgement before it grants the successor.                                           | Revocation and delayed revoke cases                                   |
| Lease           | `claim`, `renew`, and `release` implement `Claim`, `Renew`, `GiveBack`, `OneValidHolder`, and `ExpiredLeaseFreesWork`. `withHeldClaim` checks the token and deadline. This primitive requires a live lease for writes and renewal. | Lost reply, expiry boundary, takeover, release, and token limit cases |
| TerminalControl | `claim` implements `Claim`, `OneTypist`, and `ServerLearnsPane` with one persistent token counter. `withHeldClaim` checks the pane, holder, and token at `ServerPasses`. Callers own grants, machine checks, and acknowledgement.  | Pane replacement, delayed claims, and revocation cases                |

[Claims tests](../../apps/server/convex/lib/claims.test.ts)
