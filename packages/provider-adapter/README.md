# Provider adapter

Use `@codecast/provider-adapter` for the Promise API or
`@codecast/provider-adapter/effect` in an Effect service. The registry
supports Grok 1.0.13 over ACP on POSIX.

The machine service emits `session.started` and passes the last durable
sequence as `afterSeq`. The adapter starts its events after that sequence.

Read events with one consumer. Close the owned session to stop the
provider's process group. The adapter signals the group once, at scope
close or when the leader exits, whichever happens first.

A clean ACP write returns `in-doubt` because ACP provides no durable
delivery receipt. A prompt reply can still end its turn after a timeout.
The raw sink receives original provider frames, which can contain secrets.
The adapter redacts the stderr callback and provider error messages.

ACP permission prompts show up to 16 choices in provider order. The adapter
keeps IDs verbatim, skips blank or oversized IDs, and shows the first
occurrence of a duplicate ID. It redacts labels and the summary, joins
lines with spaces, and trims labels to 128 code units and the summary to 500. A missing or blank label becomes `Option N`. Only recognized ACP
kinds appear on choices. If no ID fits, the prompt omits the options list.
Send `{ "option_id": "…" }` to select a displayed choice. Semantic allow
and deny answers still work.
