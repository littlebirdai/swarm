# Edge delivery rollout

Keep `CODECAST_EDGE_DELIVERY_V1` off until the daemon can read blob parts,
enforce the advertised byte limit, and establish blob-read support before
claiming runs that need images.

The routes accept JPEG, PNG, WebP, GIF, HEIC, and HEIF images up to 8 MiB per
blob. They omit deleted images if text or another image remains. Start returns
the surviving input if an image disappears after the permit. Use the input
from the start response when it is present.

An oversized or unsupported image, or a message with only deleted images,
ends a claimed attempt and records a rejection reason in queue history.
The next poll can take the next message. Started and ambiguous attempts
stay open for settlement. Their recovery permits contain the surviving
input, which can be empty. A retryable settlement can requeue the message.
The attachment checks then apply to its new claim.

Blob reads verify the permit and lease before and after the storage read.

A binding that receives an edge run lease requires an active lease for fenced
delivery writes. Turning the flag off disables the routes. The legacy daemon
still cannot deliver on that binding, even after release or expiry.

## Fenced prompt answers

The route requires both `CODECAST_FENCED_EXECUTION_V1` and
`CODECAST_EDGE_DELIVERY_V1`.

The owner can answer an open prompt through `permissions.answerPrompt`. Cards
use the run, turn, prompt ID, and lease ID from `permissions.getPromptAddress`.
Keep that address with the card when it opens. The answer mutation takes the
actor from the authenticated session. It records one answer for that actor and
prompt in a separate command queue.

`POST /edge/v1/commands.next` returns a `prompt_answer` with the expected run and
prompt ID, current lease fence, and answer with its actor. The same command
can be read again until `commands.result` acknowledges it or the prompt
settles. Stale runs, leases, and prompts cannot issue a command. The server
requires the session owner until turn baton authority is available.
