# Relay client

Use `createRelayClient` for transient presence, cursors, and liveness.
`subscribe(hub, handler)` returns a function that removes that handler.
The last unsubscribe closes the socket at the end of the current turn.
The handler receives ordered signals and removal events. Use removal events
to clear expired or disconnected observations.

Supply a WebSocket constructor, a random function that returns values in
`[0, 1)`, and a finite, monotonic clock in milliseconds. Use the same time
base for the clock and timers. The client clamps backward clock readings
to the last reading. `setTimer` returns a function that cancels the timer.

Supply a token provider that accepts up to 16 hubs and an abort signal.
Return the kernel's status and omissions, with a relay `url` on success.
An omission with reason `inaccessible` stops requests for that subscription.
An omission with reason `unavailable`, a temporary batch failure, or a
thrown error retries with backoff. Omission IDs refer to session hubs unless
you supply a different `kind`.

Call `publish(signal, ttlMs)` with a positive TTL to retain the latest
active presence or cursor update while its subscription cannot send.
On a phone, call `pause()` when the app leaves the foreground or goes offline.
Call `resume()` when it returns to the foreground and has network access.
Call `close()` when you dispose of the client.
