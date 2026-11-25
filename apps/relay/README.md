# Relay service

The relay serves the [v1 wire contract](../../packages/relay-contract/README.md)
over WebSocket at `/relay`. `GET /health` returns 200 while the relay accepts
connections. The relay binds to loopback by default. Use a TLS proxy to expose
a WebSocket endpoint.

Set `RELAY_AUDIENCE` to the relay cell ID and `RELAY_HMAC_KEY` to at least
32 bytes of random key material encoded in unpadded base64url. The signed
token envelope is `v1.<payload>.<signature>`. The payload is UTF-8 claims JSON
encoded in unpadded base64url. The signature is HMAC-SHA-256 over the
ASCII string `v1.<payload>`, also encoded in unpadded base64url.

To rotate the signing key, set `RELAY_HMAC_PREVIOUS_KEY` to the old key and
`RELAY_HMAC_KEY` to the new key on each relay. Both use the same format.
Switch the issuer to the new key after every relay accepts it. Remove the
previous key after the last token signed with it expires.

| Environment variable                |     Default |
| ----------------------------------- | ----------: |
| `RELAY_HOST`                        | `127.0.0.1` |
| `RELAY_PORT`                        |        3100 |
| `RELAY_SIGNAL_TTL_MS`               |       15000 |
| `RELAY_HANDSHAKE_MS`                |        5000 |
| `RELAY_DRAIN_MS`                    |        2000 |
| `RELAY_RETRY_AFTER_MS`              |        5000 |
| `RELAY_QUEUE_CAPACITY`              |          64 |
| `RELAY_MAX_CONNECTIONS`             |        2048 |
| `RELAY_MAX_PRE_AUTH_CONNECTIONS`    |         128 |
| `RELAY_MAX_CONNECTIONS_PER_SUBJECT` |           8 |
| `RELAY_MAX_HUBS`                    |        2048 |
| `RELAY_MAX_SUBSCRIBERS_PER_HUB`     |         256 |

The handshake limit applies before authentication. Authenticated sockets use
a separate total limit and a per-subject limit. One subject can use at most
half of a hub's subscriber slots, rounded down with a minimum of one.

Each connection has a bounded send queue. The latest queued signal replaces
the previous signal for the same source connection, hub, and signal type.
When the queue fills, an incoming frame can evict the oldest queued signal.
A queue full of control frames drops new signals and closes the connection
if another control frame arrives. At send, the relay drops expired signals
and caps the remaining TTL at the source and recipient grant deadlines.
A grant refresh takes effect when its reply is sent. An expired refresh
leaves the prior grants and sequence intact.

On shutdown, the relay queues `hello.unavailable` with the retry delay and
allows existing sockets to close. At the drain deadline, it terminates the
remaining sockets. Killing the process loses no stored data. All relay state
exists in memory and clients send fresh observations after they reconnect.
