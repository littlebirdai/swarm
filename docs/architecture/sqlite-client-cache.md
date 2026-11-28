# SQLite client cache

The web and desktop client keep their collection cache in SQLite (`opfs-sahpool`) in a dedicated worker. Unsent work (the outbox, pending entries and pending input) stays in IndexedDB. Without OPFS, the client keeps the cache in memory.

The code is in `apps/web/store/persistence/sqlite/`:

- `worker-connection.ts` owns the epoch, the Web Lock, the owned worker and the channels of one window.
- `transition-gate.ts` runs the epoch transitions of a window one at a time.
- `worker-drain.ts` closes a worker that the window no longer uses, after it answers its queued requests.
- `epoch-requests.ts` applies a worker answer only when it is still current.
- `worker-client.ts` is the cache storage that the store calls. It holds the window buffer and the shadow state.
- `worker-host.ts` runs in the worker and answers requests on one queue.

## Epochs

An epoch names one cache file: the schema version, the account epoch, the generation and the principal. A rotation starts the next generation, which is a new, empty file. A purge starts the next account epoch. All windows follow the epoch record in `localStorage`.

A window writes the sync cursor (`syncMeta`) only into the generation that it first loaded the cursor from, once for each principal, schema version and account epoch.

## Connection states

| State    | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| Idle     | No active epoch.                                                     |
| Waiting  | An active epoch, no worker answers yet.                              |
| Owner    | The window holds the epoch lock and its own worker is ready.         |
| Peer     | Another window holds the lock. Requests go to its worker by channel. |
| Disabled | SQLite is off for this window. The memory cache serves.              |
| Closed   | The window closed the connection. Nothing more starts.               |

A drain is not a state of the connection. It holds the worker and lock of an earlier epoch until that worker answers its queue, and it cannot touch the active epoch.

## Events and transitions

| Event                                   | From                 | To                        | Effect                                                                           |
| --------------------------------------- | -------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| Attach to an epoch                      | Idle                 | Waiting                   | Opens the epoch channels and asks for the lock.                                  |
| Lock granted, worker ready              | Waiting              | Owner                     | Requests go to the own worker.                                                   |
| Worker ready announced on the channel   | Waiting              | Peer                      | Requests go to that worker.                                                      |
| Newer epoch of the same principal       | Waiting, Owner, Peer | Waiting (new epoch)       | A ready own worker drains. The window buffer stays and flushes to the new epoch. |
| Epoch of another principal or no epoch  | Waiting, Owner, Peer | Idle or Waiting           | Tears down at once and rejects the requests of the old epoch.                    |
| Lost write, write failed, hung holder   | Waiting, Owner, Peer | Waiting (next generation) | Rotates. More than three rotations without a good answer goes to Disabled.       |
| Lock lost                               | Owner                | Waiting (same epoch)      | Rejects the writes in flight and asks for the lock again.                        |
| OPFS missing, epoch record not writable | any open state       | Disabled                  | Tears down and switches to the memory cache.                                     |
| Purge                                   | any open state       | Idle                      | Tears down and writes the next account epoch.                                    |
| Close                                   | any open state       | Closed                    | Flushes the buffer to the closing epoch, then drains a ready own worker.         |

Each transition runs through the transition gate. A transition that starts while another runs waits until that one ends. Nothing inside a transition calls `ensureActiveEpoch`.

## Answers

Every request carries its epoch id. A worker answer reaches a return value or the shadow state only when the client is open, the account and the auth epoch did not change, and the epoch of the answer is still active. Otherwise the answer counts as lost on that epoch. A lost write on the still active epoch rotates to the next generation.
