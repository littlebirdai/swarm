# Edge client

`createEdgeClient({ transport })` runs hello, heartbeat, claim, renew, and
release. Each method accepts an optional abort signal. Expected failures
return a plain result with the operation name and stack. Unexpected failures
reject the Promise. Use `@codecast/edge-client/effect` to compose the service
and its layer in an Effect program.

Pass the versioned endpoint base to `createHttpEdgeTransport`, for example
`https://example.com/edge/v1/`. The transport sends each request as JSON to
the operation path below that base. The client uses the edge contract to
parse the response.

The client allows three retries after the first attempt. It starts with a
100 ms delay, doubles that delay after each retry, and waits longer if the
kernel supplies `retry_after_ms`. The default attempt timeout is 2 seconds.
The default call timeout is 10 seconds and includes retry delays. Use one
`claim_id` for retries of the same claim. The kernel must deduplicate that ID.

Use `withClaim` to run work under an automatically renewed claim. Set
`maxServerClockLeadMs` to an upper bound on how far the kernel clock can lead
the local clock. The client subtracts this allowance from the confirmed lease
time and uses monotonic elapsed time so a backward clock change cannot extend
the lease. A refused or unconfirmed renewal stops the work. The Promise
callback must stop its work when its signal aborts.

The client attempts a fenced release when the work stops. If the release
fails or the claim answer never arrives, the kernel lease will expire.
`close()` interrupts active calls and waits for known claims to finish their
release attempts.
