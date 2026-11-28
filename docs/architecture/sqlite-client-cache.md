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

Epoch changes move the window from one epoch to another, or to no epoch. They run through the transition gate (`transition-gate.ts`) one at a time. A change that starts while another runs waits until that one ends, and nothing inside a change calls `ensureActiveEpoch`. A stored epoch record that is older than the active epoch of the same principal changes nothing.

| Event                                                                                                                                                          | From                                 | To                        | Effect                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Attach to an epoch                                                                                                                                             | Idle                                 | Waiting                   | Opens the epoch channels and asks for the lock. A buffer written before the first epoch binds to it if the principal is the same. |
| Newer generation, same principal, schema version and account epoch                                                                                             | Waiting, Owner, Peer                 | Waiting (new epoch)       | A ready own worker drains. The window buffer stays and flushes to the new epoch.                                                  |
| Another account epoch, same principal and schema version                                                                                                       | Waiting, Owner, Peer                 | Waiting (new epoch)       | A ready own worker drains. The window buffer is dropped.                                                                          |
| Epoch of another principal                                                                                                                                     | Waiting, Owner, Peer                 | Waiting (new epoch)       | Tears down at once, rejects the requests of the old epoch and drops the window buffer.                                            |
| Sign-out, or stored epoch removed, marked failed, of another principal or of another schema version                                                            | Waiting, Owner, Peer                 | Idle                      | Tears down at once, rejects the requests of the old epoch and drops the window buffer.                                            |
| Failure on the active epoch: write failed, version mismatch, owner mismatch, unreadable owner, lost write, hung holder, own worker closed, worker spawn failed | Waiting, Owner, Peer                 | Waiting (next generation) | Rotates to a new, empty file. A failure for an epoch that is not active does nothing.                                             |
| Rotation whose stored epoch is of another principal or schema version, or marked failed                                                                        | Waiting, Owner, Peer                 | Idle                      | Tears down and attaches to nothing.                                                                                               |
| A fourth rotation in one account epoch without a good answer                                                                                                   | Waiting, Owner, Peer                 | Disabled                  | Moves the window buffer to the memory cache and tears down.                                                                       |
| OPFS missing, epoch record not writable                                                                                                                        | Idle, Waiting, Owner, Peer           | Disabled                  | Moves the window buffer to the memory cache, tears down and removes the epoch record listener.                                    |
| Purge                                                                                                                                                          | Idle, Waiting, Owner, Peer, Disabled | Idle                      | Drops the window buffer, tears down and writes the next account epoch. Nothing on a closed client.                                |
| Close                                                                                                                                                          | Idle, Waiting, Owner, Peer, Disabled | Closed                    | Flushes the buffer to the closing epoch, then drains a ready own worker.                                                          |

Worker and lock events stay inside one epoch. They do not use the gate, but a lost write that they cause rotates through it at once, before anything else can be sent.

| Event                                         | From           | To                                                          | Effect                                                                                                                                                   |
| --------------------------------------------- | -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lock granted                                  | Waiting, Peer  | Waiting, or Waiting (next generation) when a write was lost | Spawns the own worker. A write sent to a peer worker counts as lost and rotates. Other requests wait for the own worker.                                 |
| Own worker ready                              | Waiting        | Owner                                                       | Requests go to the own worker.                                                                                                                           |
| Worker ready announced on the channel         | Waiting        | Peer                                                        | Requests go to that worker.                                                                                                                              |
| Another worker ready announced on the channel | Peer           | Peer, or Waiting (next generation) when a write was lost    | Requests that wait go to the new worker. A write sent to the old one counts as lost and rotates.                                                         |
| Closing message from the current peer worker  | Peer           | Waiting, or Waiting (next generation) when a write was lost | Forgets that worker and asks the channel for another. A write sent to it counts as lost and rotates. A closing message from any other worker is ignored. |
| Own worker closes itself                      | Owner          | Waiting (next generation)                                   | Rotates, as for a failed write.                                                                                                                          |
| Lock lost                                     | Waiting, Owner | Waiting, or Waiting (next generation) when a write was lost | Ends the own worker and asks for the lock again. A write in flight counts as lost and rotates.                                                           |

A drain is not a state. It holds the worker and lock of an earlier epoch until that worker answers its queue or the close timeout ends, and then rejects only that epoch's requests. A request timeout rotates only the active epoch.

## Answers

Every request carries its epoch id. A worker answer reaches a return value or the shadow state only when the client is open, the account and the auth epoch did not change, and the epoch of the answer is still active. Otherwise the answer counts as lost on that epoch. A lost write on the still active epoch rotates to the next generation.
