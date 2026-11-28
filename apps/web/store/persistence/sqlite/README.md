# SQLite cache write recovery

The `cacheOwner` record stores the cursor fence. Each writer reads the fence before it writes. A partial batch saves the fence with the rows that it can store. After a rollback, the writer makes a separate attempt to save the fence. If that attempt fails, it keeps the fence in memory and retries on the next write.

The worker layer will handle a database that stays unwritable until the host closes. On `write-failed`, it must start a new cache epoch before another host uses the cache.

## Lost writes

A flush is not retried. When a flush fails as closed or timed out and its epoch is still active, the window starts the next generation. The next generation is a new file, so the file that missed the write is not used again.

A window writes the sync cursor (`syncMeta`) only into the generation that it first loaded the cursor from, once for each principal, schema version and account epoch. A later load after a rotation does not move it. A purge and a close clear it. A window that moves to a new generation while it runs keeps its rows in memory and writes only the rows that change after the move. Thus the new file holds no cursor until a window loads from it, and the next boot syncs from Convex.

A lost doc detail delete also starts the next generation, so a revoked body does not stay on disk.

An owner that closes gracefully always asks its worker to close. The worker answers the requests already in its queue, then closes, so a routine handover does not rotate the windows to an empty file.

## First paint

The web and desktop client read no paint subset before the critical keys. The store marks client state ready only after the critical keys, the restored session and the messages of the focused conversation load. A desktop panel window loads only the keys of its scope.
