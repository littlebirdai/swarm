# Turn baton availability

`pendingMessages.requestTurnTakeover` returns `disabled` unless
`SWARM_TURN_BATON=1`. With the flag on, the mutation checks session ownership.
It returns `machine_fence_required` to an owner and leaves the claim and queue intact.

The edge delivery route issues queue permits. The durable turn projection
records the open turn and prompt IDs. The projection needs the turn starter to
assign the first claim when a second person asks to steer.

To start a steer, the edge route must check the claim and the expected turn in
the same transaction that starts the delivery. A takeover must close admission
for the old holder and wait for any started steer to settle or for the daemon
to acknowledge a fence. The daemon must record the handover on disk before it
passes a steer to the agent. An uncertain delivery requires evidence or a
person's decision.

See [claims](claims.md) for the lease primitive and the
[fenced takeover model](../../tests/models/FencedTakeover.tla) for the protocol.
