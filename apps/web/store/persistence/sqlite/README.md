# SQLite cache write recovery

The `cacheOwner` record stores the cursor fence. Each writer reads the fence before it writes. A partial batch saves the fence with the rows that it can store. After a rollback, the writer makes a separate attempt to save the fence. If that attempt fails, it keeps the fence in memory and retries on the next write.

The worker layer will handle a database that stays unwritable until the host closes. On `write-failed`, it must start a new cache epoch before another host uses the cache.
