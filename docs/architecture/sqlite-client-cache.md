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

Epoch changes move the window from one epoch to another. They run through the transition gate (`transition-gate.ts`) one at a time. A change that starts while another runs waits until that one ends, and nothing inside a change calls `ensureActiveEpoch`.

| Event                                                                       | From                                 | To                        | Effect                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------- |
| Attach to an epoch                                                          | Idle                                 | Waiting                   | Opens the epoch channels and asks for the lock.                                        |
| Newer epoch of the same principal and account epoch                         | Waiting, Owner, Peer                 | Waiting (new epoch)       | A ready own worker drains. The window buffer stays and flushes to the new epoch.       |
| Epoch of another schema version or account epoch, same principal            | Waiting, Owner, Peer                 | Waiting (new epoch)       | A ready own worker drains. The window buffer is dropped.                               |
| Epoch of another principal                                                  | Waiting, Owner, Peer                 | Waiting (new epoch)       | Tears down at once, rejects the requests of the old epoch and drops the window buffer. |
| Stored epoch removed, marked failed or of another principal                 | Waiting, Owner, Peer                 | Idle                      | Tears down at once and rejects the requests of the old epoch.                          |
| Lost write, write failed, owner unreadable, hung holder on the active epoch | Waiting, Owner, Peer                 | Waiting (next generation) | Rotates. A failure for an epoch that is not active does nothing.                       |
| Rotation whose stored epoch is of another principal or marked failed        | Waiting, Owner, Peer                 | Idle                      | Tears down and attaches to nothing.                                                    |
| A fourth rotation in one account epoch without a good answer                | Waiting, Owner, Peer                 | Disabled                  | Tears down and switches to the memory cache.                                           |
| OPFS missing, epoch record not writable                                     | Idle, Waiting, Owner, Peer           | Disabled                  | Tears down and switches to the memory cache.                                           |
| Purge                                                                       | Idle, Waiting, Owner, Peer           | Idle                      | Tears down and writes the next account epoch.                                          |
| Close                                                                       | Idle, Waiting, Owner, Peer, Disabled | Closed                    | Flushes the buffer to the closing epoch, then drains a ready own worker.               |

Worker and lock events stay inside one epoch. They do not use the gate.

| Event                                         | From           | To                        | Effect                                                                                 |
| --------------------------------------------- | -------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Lock granted                                  | Waiting, Peer  | Waiting                   | Spawns the own worker. Requests wait for it.                                           |
| Own worker ready                              | Waiting        | Owner                     | Requests go to the own worker.                                                         |
| Worker ready announced on the channel         | Waiting        | Peer                      | Requests go to that worker.                                                            |
| Another worker ready announced on the channel | Peer           | Peer                      | Requests that wait go to the new worker. Writes sent to the old one count as lost.     |
| Worker closing                                | Owner, Peer    | Waiting                   | Forgets that worker and asks the channel for another. Writes sent to it count as lost. |
| Lock lost                                     | Waiting, Owner | Waiting                   | Ends the own worker, rejects the writes in flight and asks for the lock again.         |
| Worker spawn fails                            | Waiting        | Waiting (next generation) | Rotates, as for a failed write.                                                        |

A drain is not a state. It holds the worker and lock of an earlier epoch until that worker answers its queue or the close timeout ends, and then rejects only that epoch's requests. A request timeout rotates only the active epoch.

## Answers

Every request carries its epoch id. A worker answer reaches a return value or the shadow state only when the client is open, the account and the auth epoch did not change, and the epoch of the answer is still active. Otherwise the answer counts as lost on that epoch. A lost write on the still active epoch rotates to the next generation.
