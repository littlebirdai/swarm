# Provider adapter

Use `@codecast/provider-adapter` for the Promise API or
`@codecast/provider-adapter/effect` in an Effect service. The registry
supports Grok 1.0.13 over ACP on POSIX.

The machine service emits `session.started` and passes the last durable
sequence as `afterSeq`. The adapter starts its events after that sequence.

Read events with one consumer. Close the owned session to stop the
provider's process group. Scope close stops the group while its leader is
live. After the leader exits, the adapter cannot safely signal its former
group ID.

A clean ACP write returns `in-doubt` because ACP provides no durable
delivery receipt. A prompt reply can still end its turn after a timeout.
The raw sink receives original provider frames, which can contain secrets.
The adapter redacts the stderr callback and provider error messages.
