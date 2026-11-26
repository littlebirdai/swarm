# Turn baton availability

`pendingMessages.requestTurnTakeover` returns `disabled` unless
`SWARM_TURN_BATON=1`. With the flag on, the mutation checks session ownership.
It returns `machine_fence_required` to an owner and leaves the claim and queue intact.

The edge delivery route issues queue permits. The delivery kernel reserves
the oldest nonterminal message and checks the sequence on delivery start.
A message that waits for the turn to end would occupy that position and
block later steering. The kernel needs to support both intents while
keeping one active delivery slot.

The wire contract carries a turn starter. The server projection stores
the turn and prompt IDs. To assign the first claim on join, the projection
writer needs to store the verified starter. Moving that writer to its
kebab-case path requires an import update in the delivery kernel.

To start a steer, the edge route must check the claim and the expected turn
in the same transaction that starts the delivery. A takeover must close
admission for the old holder and wait for a started steer to settle or for
the daemon to acknowledge a fence. The wire contract defines `takeover.ack`.
The server still needs a contract for sending a fence to the daemon. An
uncertain steer requires a person's decision before any resend.

See [claims](claims.md) for the lease primitive and the
[fenced takeover model](../../tests/models/FencedTakeover.tla) for the protocol.
