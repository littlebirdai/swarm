---- MODULE SwarmFlow ----
\* One message travels through the target swarm architecture:
\* your device (local-first store) -> kernel session inbox -> machine service
\* -> agent (owned over ACP/SDK) -> kernel session machine (only status writer)
\* -> event log in a session scope -> a teammate who follows the session.
\* Faults: the send or its acknowledgement is lost once; the machine restarts once
\* while it holds the message.
EXTENDS Naturals
CONSTANTS Scope, Dedup, Receipts

VARIABLES dev, req, lost, copies, inbox, machine, crashed,
          agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes
vars == <<dev, req, lost, copies, inbox, machine, crashed,
          agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>

Init == /\ dev = "typing" /\ req = "none" /\ lost = FALSE /\ copies = 0
        /\ inbox = "empty" /\ machine = "up" /\ crashed = FALSE
        /\ agentGot = 0 /\ agent = "idle" /\ status = "idle"
        /\ logPos = 0 /\ mateSeen = 0 /\ mateShows = "idle" /\ outsiderWakes = 0

Accept == /\ copies' = IF Dedup THEN 1 ELSE copies + 1   \* dedup by client id
          /\ inbox' = IF inbox = "empty" THEN "queued" ELSE inbox

YouSend == dev = "typing" /\ dev' = "shown" /\ req' = "inflight"
  /\ UNCHANGED <<lost, copies, inbox, machine, crashed, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>
SendLost == req = "inflight" /\ ~lost /\ req' = "none" /\ lost' = TRUE
  /\ UNCHANGED <<dev, copies, inbox, machine, crashed, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>
AckLost == req = "inflight" /\ ~lost /\ req' = "none" /\ lost' = TRUE /\ Accept
  /\ UNCHANGED <<dev, machine, crashed, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>
AppRetries == dev = "shown" /\ req = "none" /\ req' = "inflight"
  /\ UNCHANGED <<dev, lost, copies, inbox, machine, crashed, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>
KernelAccepts == req = "inflight" /\ req' = "none" /\ dev' = "confirmed" /\ Accept
  /\ UNCHANGED <<lost, machine, crashed, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>

MachineTakes == machine = "up" /\ inbox = "queued" /\ inbox' = "handed"
  /\ UNCHANGED <<dev, req, lost, copies, machine, crashed, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>
AgentGetsMessage == machine = "up" /\ inbox = "handed" /\ (IF Receipts THEN agentGot = 0 ELSE agentGot < 2)
  /\ agentGot' = agentGot + 1 /\ agent' = "working"
  /\ UNCHANGED <<dev, req, lost, copies, inbox, machine, crashed, status, logPos, mateSeen, mateShows, outsiderWakes>>
\* The adapter reports a receipt keyed by message id; after a restart it asks the
\* agent whether it already holds that id instead of sending again.
KernelRecordsReceipt == machine = "up" /\ inbox = "handed" /\ agentGot >= 1
  /\ inbox' = "delivered" /\ status' = "working" /\ logPos' = logPos + 1
  /\ UNCHANGED <<dev, req, lost, copies, machine, crashed, agentGot, agent, mateSeen, mateShows, outsiderWakes>>
MachineRestarts == machine = "up" /\ ~crashed /\ inbox = "handed"
  /\ machine' = "down" /\ crashed' = TRUE
  /\ UNCHANGED <<dev, req, lost, copies, inbox, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>
MachineBack == machine = "down" /\ machine' = "up"
  /\ UNCHANGED <<dev, req, lost, copies, inbox, crashed, agentGot, agent, status, logPos, mateSeen, mateShows, outsiderWakes>>
AgentFinishes == agent = "working" /\ agent' = "finished"
  /\ UNCHANGED <<dev, req, lost, copies, inbox, machine, crashed, agentGot, status, logPos, mateSeen, mateShows, outsiderWakes>>
KernelRecordsEnd == machine = "up" /\ agent = "finished" /\ status = "working"
  /\ status' = "done" /\ logPos' = logPos + 1
  /\ UNCHANGED <<dev, req, lost, copies, inbox, machine, crashed, agentGot, agent, mateSeen, mateShows, outsiderWakes>>

MateCatchesUp == mateSeen < logPos /\ mateSeen' = logPos /\ mateShows' = status
  /\ UNCHANGED <<dev, req, lost, copies, inbox, machine, crashed, agentGot, agent, status, logPos, outsiderWakes>>
OutsiderWoken == Scope = "team" /\ outsiderWakes < logPos /\ outsiderWakes' = logPos
  /\ UNCHANGED <<dev, req, lost, copies, inbox, machine, crashed, agentGot, agent, status, logPos, mateSeen, mateShows>>

Done == dev = "confirmed" /\ status = "done" /\ mateSeen = logPos
        /\ (Scope = "interest" \/ outsiderWakes = logPos) /\ UNCHANGED vars

Next == YouSend \/ SendLost \/ AckLost \/ AppRetries \/ KernelAccepts
     \/ MachineTakes \/ AgentGetsMessage \/ KernelRecordsReceipt
     \/ MachineRestarts \/ MachineBack \/ AgentFinishes \/ KernelRecordsEnd
     \/ MateCatchesUp \/ OutsiderWoken \/ Done
Spec == Init /\ [][Next]_vars

\* Rules
NeverDeliveredTwice == agentGot <= 1
OneCopyOnServer == copies <= 1
SavedMeansStored == dev = "confirmed" => copies = 1
StatusNeverAhead == /\ (status = "working" => agentGot = 1)
                    /\ (status = "done" => agent = "finished")
TeammateNeverAhead == /\ (mateShows = "working" => status \in {"working", "done"})
                      /\ (mateShows = "done" => status = "done")
OutsiderStaysAsleep == outsiderWakes = 0
====
