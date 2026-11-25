---- MODULE Delivery ----
(* One message in a session inbox, from "waiting" to "delivered".
   Server: owns the message status and the execution epoch (a fence).
   Daemon: holds a permit for one attempt, and can forget what it did.
   Host:   the agent process of one epoch. In "own" mode (Receipts = TRUE)
           it records each delivery id it applied, durably, and reports
           them when a new host loads the session. In "observe/paste" mode
           (Receipts = FALSE) nothing records what the agent took. *)
EXTENDS Naturals

CONSTANTS Receipts, MaxEpoch

VARIABLES
  st,      \* server: waiting | claimed | started | delivered | ambiguous
  pEpoch,  \* server: the epoch the open permit was issued for (0 = none)
  epoch,   \* server: current execution epoch
  host,    \* the live host's epoch, 0 = no host
  d,       \* daemon memory: none | fresh | sent | unknown
  got,     \* how many times the agent took the message as input
  rc       \* own mode: the host recorded this delivery id

vars == <<st, pEpoch, epoch, host, d, got, rc>>

Init ==
  /\ st = "waiting" /\ pEpoch = 0 /\ epoch = 1 /\ host = 1
  /\ d = "none" /\ got = 0 /\ rc = FALSE

\* The server gives the daemon a permit for the head of the queue.
Claim ==
  /\ st = "waiting" /\ host = epoch
  /\ st' = "claimed" /\ pEpoch' = epoch /\ d' = "fresh"
  /\ UNCHANGED <<epoch, host, got, rc>>

\* The daemon records "delivery started" on the server before any effect.
Start ==
  /\ st = "claimed" /\ pEpoch = epoch /\ d = "fresh"
  /\ st' = "started"
  /\ UNCHANGED <<pEpoch, epoch, host, d, got, rc>>

\* The daemon hands the message to the host. A daemon that forgot what it
\* did may retry only when the host can answer "duplicate".
Apply ==
  /\ st = "started" /\ pEpoch = host
  /\ \/ d = "fresh"
     \/ (d = "unknown" /\ Receipts)
  /\ IF Receipts /\ rc
       THEN UNCHANGED <<got, rc>>
       ELSE got' = got + 1 /\ rc' = TRUE
  /\ d' = "sent"
  /\ UNCHANGED <<st, pEpoch, epoch, host>>

Ack ==
  /\ st = "started" /\ d = "sent" /\ pEpoch = epoch
  /\ st' = "delivered" /\ d' = "none" /\ pEpoch' = 0
  /\ UNCHANGED <<epoch, host, got, rc>>

DaemonRestarts ==
  /\ d \in {"fresh", "sent"}
  /\ d' = "unknown"
  /\ UNCHANGED <<st, pEpoch, epoch, host, got, rc>>

\* A permit that never started has had no effect: back to the queue.
Requeue ==
  /\ st = "claimed" /\ d = "unknown"
  /\ st' = "waiting" /\ d' = "none" /\ pEpoch' = 0
  /\ UNCHANGED <<epoch, host, got, rc>>

\* Paste mode: a started attempt the daemon cannot account for.
ReportAmbiguous ==
  /\ st = "started" /\ d = "unknown" /\ ~Receipts
  /\ st' = "ambiguous" /\ d' = "none" /\ pEpoch' = 0
  /\ UNCHANGED <<epoch, host, got, rc>>

HostDies ==
  /\ host # 0 /\ st # "delivered"
  /\ host' = 0
  /\ UNCHANGED <<st, pEpoch, epoch, d, got, rc>>

\* A successor epoch opens only after the old runtime is proven gone.
Reopen ==
  /\ host = 0 /\ epoch < MaxEpoch
  /\ epoch' = epoch + 1 /\ host' = epoch + 1
  /\ UNCHANGED <<st, pEpoch, d, got, rc>>

\* The server retires a permit of an older epoch. In own mode the new host
\* has reported its receipts, so the server knows whether the effect happened.
Supersede ==
  /\ st \in {"claimed", "started"} /\ pEpoch # 0 /\ pEpoch < epoch
  /\ st' = IF st = "claimed" THEN "waiting"
           ELSE IF Receipts THEN (IF rc THEN "delivered" ELSE "waiting")
           ELSE "ambiguous"
  /\ d' = "none" /\ pEpoch' = 0
  /\ UNCHANGED <<epoch, host, got, rc>>

\* Paste mode: the transcript shows the message, which settles the doubt.
Correlate ==
  /\ st = "ambiguous" /\ got >= 1
  /\ st' = "delivered"
  /\ UNCHANGED <<pEpoch, epoch, host, d, got, rc>>

\* Paste mode: a person chooses "send again" on an ambiguous delivery.
SendAgain ==
  /\ st = "ambiguous"
  /\ st' = "waiting"
  /\ UNCHANGED <<pEpoch, epoch, host, d, got, rc>>

Done ==
  /\ st = "delivered"
  /\ UNCHANGED vars

\* Model bound: no more epochs to open.
Parked ==
  /\ host = 0 /\ epoch = MaxEpoch
  /\ UNCHANGED vars

Next ==
  \/ Claim \/ Start \/ Apply \/ Ack \/ DaemonRestarts \/ Requeue
  \/ ReportAmbiguous \/ HostDies \/ Reopen \/ Supersede
  \/ Correlate \/ SendAgain \/ Done \/ Parked

Spec == Init /\ [][Next]_vars

\* --- Rules ---
\* A message is never delivered twice.
NeverDeliveredTwice == got <= 1
\* A message shown as delivered reached the agent.
DeliveredMeansGot == st = "delivered" => got >= 1
\* A message shown as waiting has not reached the agent.
WaitingMeansNotGot == st = "waiting" => got = 0
\* The agent takes input only under the current epoch's permit.
OnePermit == (pEpoch # 0) <=> (st \in {"claimed", "started"})

\* Model bound for paste mode, where "send again" can repeat without end.
Bound == got <= 2
====
