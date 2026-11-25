# Edge delivery rollout

Keep `CODECAST_EDGE_DELIVERY_V1` off until the daemon can read blob parts,
enforce the advertised byte limit, and establish blob-read support before
claiming runs that need images.

The routes accept JPEG, PNG, WebP, GIF, HEIC, and HEIF images up to 8 MiB per
blob. They omit deleted images if text or another image remains. Start returns
the surviving input if an image disappears after the permit. Use the input
from the start response when it is present.

An oversized or unsupported image, or a message with only deleted images,
ends the attempt and records a rejection reason in queue history. The next
poll can take the next message. If the attempt already started, the reason
also says that the delivery may have reached the agent.

Blob reads verify the permit and lease before and after the storage read.

A binding that receives an edge run lease requires an active lease for fenced
delivery writes. Turning the flag off disables the routes. The legacy daemon
still cannot deliver on that binding, even after release or expiry.
