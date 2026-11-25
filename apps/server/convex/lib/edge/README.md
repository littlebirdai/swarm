# Edge delivery rollout

Keep `CODECAST_EDGE_DELIVERY_V1` off until delivery permits support blob parts.
The routes preserve queued attachments. An attachment at the head of the queue
blocks later messages until it can be delivered. The fenced queue has no retry
action for terminal rejections.

A binding that receives an edge run lease requires an active lease for fenced
delivery writes. Turning the flag off disables the routes. The legacy daemon
still cannot deliver on that binding, even after release or expiry.
