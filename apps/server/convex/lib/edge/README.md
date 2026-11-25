# Edge delivery rollout

Keep `CODECAST_EDGE_DELIVERY_V1` off until the daemon can read blob parts,
enforce the advertised byte limit, and establish blob-read support before
claiming runs that need images.

The routes accept JPEG, PNG, WebP, GIF, HEIC, and HEIF images up to 8 MiB per
blob. A missing, oversized, or unsupported attachment stays queued, just as
an image that the current daemon cannot resolve. It blocks later messages
while it remains at the head of the queue.

A binding that receives an edge run lease requires an active lease for fenced
delivery writes. Turning the flag off disables the routes. The legacy daemon
still cannot deliver on that binding, even after release or expiry.
