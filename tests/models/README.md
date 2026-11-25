# Protocol models

These TLA+ models describe the target protocols. TLC checks each configuration
against [expectations.json](./expectations.json).

## Run the checks

Use Bun and Java 17 or later. If Java is outside your PATH, set `JAVA_HOME`.

```sh
bun tests/models/run-models.ts
bun test tests/models/tlc-result.test.ts
```

The runner downloads TLC 1.7.4 on first use and checks its SHA-256 before each
use. It stores the JAR under `$XDG_CACHE_HOME/swarm/tlc` or
`~/.cache/swarm/tlc`. CI uses Java 17 from the Ubuntu runner image.

The `invariants` and `properties` lists pin every rule in each configuration.
Every configuration must check at least one rule. An empty `violations` list
requires a successful run. A named violation requires
a TLC counterexample for that rule. To check the next rule, the runner removes
the failed invariant from a temporary copy of the configuration and runs TLC
again. A temporal counterexample must come from a configuration with one property.

`distinctStates` is TLC's count after a complete search. For configurations with
`stopAfterCounterexamples`, it is the count at the last expected counterexample,
if specified. The largest mutations use this mode to preserve the known
counterexamples from the original bounded checks.

## Models

- **CacheHost** models cache writes and reads when a host hangs, restarts, or
  loses its lease. It checks that a new host can serve and that readers skip no
  rows and see only their account's rows.
- **CoSteer** models two people who send messages to one agent and share the turn.
  It checks that the baton stays with its holder until a steer in flight settles.
- **Delivery** models message delivery across lost replies, runtime changes, and
  retries. It checks that receipts keep retries safe and shows which guarantees
  fail after a person chooses to resend in paste mode.
- **FencedTakeover** models owner takeover while another person's steer is in
  flight. It checks that no late steer lands after takeover and that a stable
  connection lets the owner take control.
- **Lease** models claims, renewal, expiry, and fencing tokens. It checks that
  only the current claim can complete the work, even when a silent holder keeps
  working.
- **LoneJoin** models a second person who asks to steer a session with one active
  sender. It checks that a lone sender writes no claim row and that the second
  person can take over after the holder goes away.
- **OutboxMove** models unsent work across a storage migration, a crash, a
  rollback, and sign-out. It checks that each action reaches the server at most
  once, under its own account, and eventually arrives or is discarded at sign-out.
- **PromptAnswer** models the path from an answer on a prompt card to the agent.
  It checks that one eligible person can settle the current prompt and that a
  stale answer cannot reach a later prompt.
- **StaleSteer** models a steer or interrupt that names the turn from which it
  was sent. It checks that the action affects only that turn and that the
  machine check also works by itself.
- **SwarmFlow** models one message from a local send through storage, agent
  delivery, and notification. It checks delivery, status, and recipient rules
  with retries, a machine restart, and different notification scopes.
- **TerminalControl** models a typing lease across pane replacement, token
  revocation, and out-of-order control messages. It checks that the current
  typist's keys reach the correct pane, including when keys travel by relay.
- **TurnBaton** models two senders and one owner who can take the turn. It checks
  that only the holder can send into a turn and that only one steer is in flight.
