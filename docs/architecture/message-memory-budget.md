# Message memory budget

Web and desktop enforce strict transcript eviction. The store estimates the
bytes held by message pages and user-message rows against a 32 MiB budget.
Inactive pages can be evicted and restored from the cache when reopened.

When an image has a storage reference, message rows keep that reference and
omit the redundant inline bytes. An image that exists only inline stays in
memory while a mounted reader needs it. When the conversation becomes inactive
and has no remaining protection, the store evicts the page from memory.

Protected transcripts can exceed the budget. This includes open conversations,
streaming sessions, and conversations with pending sends. The store rechecks
them when their protection lifts.
