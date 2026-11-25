---- MODULE FencedTakeover ----
(* Ben drives. Ana owns the session and takes the baton while a steer of Ben can
   be on its way. The server, the daemon and the agent process are separate.
   Messages cross a network that loses what it holds when the machine
   disconnects. The agent process outlives a daemon restart. *)
EXTENDS Naturals

CONSTANTS
  ServerCheck,   \* the server starts a steer only while Ben holds the baton
  MachineCheck,  \* the daemon compares the fence immediately before it hands over
  WaitForAck,    \* Ana holds the baton only after the old steer settled or the ack
  AckWaits,      \* the daemon acknowledges only when no handed steer is open
  PersistStart,  \* the daemon records the hand-over on disk before it hands over
  PersistFence   \* the fence survives a daemon restart

VARIABLES
  holder,   \* server: "ben" | "pending" | "ana"
  st,       \* server: "none" | "permit" | "started" | "doubt" | "settled"
  ack,      \* server: the fence was acknowledged
  online,
  m,        \* daemon memory: "none" | "permit" | "asked" | "ok"
  fence,    \* daemon memory
  disk,     \* daemon disk: fence
  mem,      \* daemon memory: a steer was handed over
  startLog, \* daemon disk: a steer was handed over
  agent,    \* agent process: "none" | "handed" | "landed"
  net,
  intruded

vars == <<holder, st, ack, online, m, fence, disk, mem, startLog, agent, net, intruded>>

Init ==
  /\ holder = "ben" /\ st = "none" /\ ack = FALSE /\ online = TRUE
  /\ m = "none" /\ fence = FALSE /\ disk = FALSE /\ mem = FALSE /\ startLog = FALSE
  /\ agent = "none" /\ net = {} /\ intruded = FALSE

Issue ==
  /\ online /\ holder = "ben" /\ st = "none"
  /\ st' = "permit" /\ net' = net \cup {"permit"}
  /\ UNCHANGED <<holder, ack, online, m, fence, disk, mem, startLog, agent, intruded>>

Request ==
  /\ holder = "ben"
  /\ holder' = IF WaitForAck THEN "pending" ELSE "ana"
  /\ net' = IF online THEN net \cup {"fence"} ELSE net
  /\ UNCHANGED <<st, ack, online, m, fence, disk, mem, startLog, agent, intruded>>

\* A permit that the server never started can not start any more.
Resolve ==
  /\ holder = "pending"
  /\ st \in {"none", "permit", "settled"} \/ ack
  /\ holder' = "ana"
  /\ UNCHANGED <<st, ack, online, m, fence, disk, mem, startLog, agent, net, intruded>>

RecvPermit ==
  /\ online /\ "permit" \in net /\ m = "none"
  /\ m' = "permit" /\ net' = net \ {"permit"}
  /\ UNCHANGED <<holder, st, ack, online, fence, disk, mem, startLog, agent, intruded>>

Ask ==
  /\ online /\ m = "permit"
  /\ m' = "asked" /\ net' = net \cup {"ask"}
  /\ UNCHANGED <<holder, st, ack, online, fence, disk, mem, startLog, agent, intruded>>

SrvStart ==
  /\ "ask" \in net /\ st = "permit"
  /\ IF ServerCheck => holder = "ben"
       THEN st' = "started" /\ net' = (net \ {"ask"}) \cup {"ok"}
       ELSE st' = "settled" /\ net' = net \ {"ask"}
  /\ UNCHANGED <<holder, ack, online, m, fence, disk, mem, startLog, agent, intruded>>

RecvOk ==
  /\ online /\ "ok" \in net /\ m = "asked"
  /\ m' = "ok" /\ net' = net \ {"ok"}
  /\ UNCHANGED <<holder, st, ack, online, fence, disk, mem, startLog, agent, intruded>>

\* Also while the machine is offline: the daemon already has the answer.
Hand ==
  /\ m = "ok"
  /\ m' = "none"
  /\ IF MachineCheck /\ fence
       THEN UNCHANGED <<mem, startLog, agent>>
       ELSE mem' = TRUE /\ startLog' = PersistStart /\ agent' = "handed"
  /\ UNCHANGED <<holder, st, ack, online, fence, disk, net, intruded>>

Land ==
  /\ agent = "handed"
  /\ agent' = "landed"
  /\ intruded' = (intruded \/ holder = "ana")
  /\ UNCHANGED <<holder, st, ack, online, m, fence, disk, mem, startLog, net>>

Report ==
  /\ online /\ agent = "landed" /\ (mem \/ startLog) /\ st # "settled"
  /\ net' = net \cup {"settle"}
  /\ UNCHANGED <<holder, st, ack, online, m, fence, disk, mem, startLog, agent, intruded>>

SrvSettle ==
  /\ "settle" \in net
  /\ st' = "settled" /\ net' = net \ {"settle"}
  /\ UNCHANGED <<holder, ack, online, m, fence, disk, mem, startLog, agent, intruded>>

RecvFence ==
  /\ online /\ "fence" \in net
  /\ fence' = TRUE /\ disk' = (disk \/ PersistFence) /\ net' = net \ {"fence"}
  /\ UNCHANGED <<holder, st, ack, online, m, mem, startLog, agent, intruded>>

SendAck ==
  /\ online /\ fence /\ ~ack
  /\ AckWaits => ~((mem \/ startLog) /\ agent = "handed")
  /\ net' = net \cup {"ack"}
  /\ UNCHANGED <<holder, st, ack, online, m, fence, disk, mem, startLog, agent, intruded>>

SrvAck ==
  /\ "ack" \in net
  /\ ack' = TRUE /\ net' = net \ {"ack"}
  /\ UNCHANGED <<holder, st, online, m, fence, disk, mem, startLog, agent, intruded>>

Disconnect ==
  /\ online
  /\ online' = FALSE /\ net' = {}
  /\ st' = IF st = "started" THEN "doubt" ELSE st
  /\ UNCHANGED <<holder, ack, m, fence, disk, mem, startLog, agent, intruded>>

\* The server sends the fence again while it has no acknowledgement.
Reconnect ==
  /\ ~online
  /\ online' = TRUE
  /\ net' = IF holder # "ben" /\ ~ack THEN {"fence"} ELSE {}
  /\ UNCHANGED <<holder, st, ack, m, fence, disk, mem, startLog, agent, intruded>>

Restart ==
  /\ m' = "none" /\ fence' = disk /\ mem' = FALSE
  /\ online' = FALSE /\ net' = {}
  /\ st' = IF st = "started" THEN "doubt" ELSE st
  /\ UNCHANGED <<holder, ack, disk, startLog, agent, intruded>>

Next ==
  \/ Issue \/ Request \/ Resolve \/ RecvPermit \/ Ask \/ SrvStart \/ RecvOk \/ Hand
  \/ Land \/ Report \/ SrvSettle \/ RecvFence \/ SendAck \/ SrvAck
  \/ Disconnect \/ Reconnect \/ Restart

Spec == Init /\ [][Next]_vars

FairSpec ==
  /\ Spec
  /\ WF_vars(Reconnect) /\ WF_vars(RecvFence) /\ WF_vars(SendAck) /\ WF_vars(SrvAck)
  /\ WF_vars(Resolve) /\ WF_vars(Land)

\* After Ana holds the baton, no steer of Ben reaches the agent.
NoLateSteer == ~intruded
\* Ana can always ask: nothing about the machine or the delivery refuses it.
RequestAccepted == holder = "ben" => ENABLED Request
\* If the machine stays connected from some time on, the request ends with Ana.
TakeoverResolves == <>[][~Restart /\ ~Disconnect]_vars => (holder = "pending" ~> holder = "ana")
====
