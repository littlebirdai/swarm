# Edge client

`createEdgeClient({ transport })` runs hello, heartbeat, claim, renew, and
release. Each method accepts an optional abort signal. Expected failures
return a plain result with a stack that includes the caller. Unexpected
failures reject the Promise. Use `@codecast/edge-client/effect` to compose
the service and its layer in an Effect program.

Pass the versioned endpoint base to `createHttpEdgeTransport`. The transport
sends a JSON request to the operation path below that base. The edge contract
parses the response. Custom transports can throw `EdgeTransportError` with
the original network error as its cause.

Heartbeat sends one attempt. Other calls allow up to three retries with
exponential backoff and jitter. The delay respects the server's retry hint.
The default attempt timeout is 2 seconds. The default call timeout is 10
seconds and includes retry delays. The kernel must deduplicate retries with
the same `claim_id`.

Use `withClaim` to run work under an automatically renewed claim. The client
counts `lease_ms` from the start of each successful attempt. It uses wall time
when that clock shows more elapsed time than the monotonic clock, as can
happen during machine sleep. The client stops work before the lease expires
and retries transient renewal failures while the lease still permits them.

When work loses its claim or the call is interrupted, the client aborts the
callback's signal and waits for its Promise to settle before releasing the
claim. A callback that never settles keeps the session reserved and prevents
`withClaim()` and, if called, `close()` from finishing. Release uses a single
bounded attempt. A stale renewal means the server already rejected the token,
so the client skips release.

## Enable steer delivery in a host

Pass an `EdgeSteeringHost` as `steering` when you create the client. The
client offers `steer-baton-v1` and `takeover-fence-v1` in `hello` only with
this option. Run `hello` before you poll so the client can use the server's
negotiated capabilities.

- Return the live turn ID from `runningTurn`, or `null` between turns.
- Use `prepare` for input preparation. Return a function that initiates the
  agent handoff when called. The client checks the turn and records the
  handover before it calls that function.
- Implement `journal.load` and `journal.save` for each session and run. Save
  the whole snapshot atomically and confirm the write after it is durable.
  Use the same journal after a restart. Close the current client before a
  replacement starts delivery for the same run.
- Use `recover` to look up the existing attempt. Return `in_doubt` while its
  effect is uncertain. Supply provider evidence when you know the result.

Call `deliverNext` with the live run lease. Handle a queue permit with your
queue delivery path. A stale steer returns its settlement receipt and leaves
the agent untouched. Keep polling when a takeover returns `pending`.
A `takeover` result carries the server's acknowledgment receipt. A stale
receipt leaves the old baton fenced. A steer under a different baton still
needs its own permit.
