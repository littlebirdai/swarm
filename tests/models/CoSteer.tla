---- MODULE CoSteer ----
(* Two people in one live agent session. ana owns the session, ben was
   invited and may send. Each can send one message, as "steer" (reach the
   running turn now) or "queue" (wait for the turn to end).
   The turn baton is a server-side lease: its holder is the one steerer.
   Delivery itself is checked in Delivery.tla; here a message goes
   waiting -> started -> in, and "started" cannot be recalled. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Guard   \* TRUE: the baton cannot move to another person while a steer is in flight

Humans == {"ana", "ben"}
Owner == "ana"

VARIABLES
  holders,    \* server: who holds the turn baton (a set, to check it stays <= 1)
  turn,       \* idle | running
  msg,        \* per person: none | steer | queue | started | in
  kind,       \* per person: what a started message was sent as (steer | queue | none)
  ask,        \* the agent's permission prompt: none | open | answered
  intruded,   \* a message reached a running turn while someone else held the baton
  badAnswer   \* the prompt was answered by someone not allowed to

vars == <<holders, turn, msg, kind, ask, intruded, badAnswer>>

Init ==
  /\ holders = {} /\ turn = "idle"
  /\ msg = [h \in Humans |-> "none"] /\ kind = [h \in Humans |-> "none"]
  /\ ask = "none" /\ intruded = FALSE /\ badAnswer = FALSE

Others(h) == Humans \ {h}

\* A steer of someone else is on its way into the running turn.
SteerInFlight(h) ==
  \E o \in Others(h) : msg[o] = "started" /\ kind[o] = "steer" /\ turn = "running"

Take(h) ==
  /\ holders = {}
  /\ Guard => ~SteerInFlight(h)
  /\ holders' = {h}
  /\ UNCHANGED <<turn, msg, kind, ask, intruded, badAnswer>>

\* The holder lets go, leaves, or the lease runs out.
Release(h) ==
  /\ h \in holders
  /\ holders' = {}
  /\ UNCHANGED <<turn, msg, kind, ask, intruded, badAnswer>>

\* The session owner takes the baton from whoever holds it.
OwnerTakes ==
  /\ holders # {} /\ Owner \notin holders
  /\ Guard => ~SteerInFlight(Owner)
  /\ holders' = {Owner}
  /\ UNCHANGED <<turn, msg, kind, ask, intruded, badAnswer>>

Send(h, mode) ==
  /\ msg[h] = "none"
  /\ msg' = [msg EXCEPT ![h] = mode]
  /\ UNCHANGED <<holders, turn, kind, ask, intruded, badAnswer>>

\* The server starts a delivery: one at a time. A queued message waits for
\* an idle turn; a steer goes into a running turn only from the holder.
Start(h) ==
  /\ msg[h] \in {"steer", "queue"}
  /\ \A o \in Others(h) : msg[o] # "started"
  /\ \/ turn = "idle"
     \/ (msg[h] = "steer" /\ h \in holders)
  /\ kind' = [kind EXCEPT ![h] = msg[h]]
  /\ msg' = [msg EXCEPT ![h] = "started"]
  /\ UNCHANGED <<holders, turn, ask, intruded, badAnswer>>

Land(h) ==
  /\ msg[h] = "started"
  /\ msg' = [msg EXCEPT ![h] = "in"]
  /\ intruded' = (intruded \/ (turn = "running" /\ holders # {} /\ h \notin holders))
  /\ turn' = "running"
  /\ UNCHANGED <<holders, kind, ask, badAnswer>>

AgentAsks ==
  /\ turn = "running" /\ ask = "none"
  /\ ask' = "open"
  /\ UNCHANGED <<holders, turn, msg, kind, intruded, badAnswer>>

\* The holder answers; the owner answers when nobody holds the baton.
MayAnswer(h) == h \in holders \/ (holders = {} /\ h = Owner)

Answer(h) ==
  /\ ask = "open" /\ MayAnswer(h)
  /\ ask' = "answered"
  /\ badAnswer' = (badAnswer \/ ~(h \in holders \/ (holders = {} /\ h = Owner)))
  /\ UNCHANGED <<holders, turn, msg, kind, intruded>>

TurnEnds ==
  /\ turn = "running" /\ ask # "open"
  /\ turn' = "idle"
  /\ UNCHANGED <<holders, msg, kind, ask, intruded, badAnswer>>

Next ==
  \/ \E h \in Humans : Take(h) \/ Release(h) \/ Start(h) \/ Land(h) \/ Answer(h)
  \/ \E h \in Humans, mode \in {"steer", "queue"} : Send(h, mode)
  \/ OwnerTakes \/ AgentAsks \/ TurnEnds

Spec == Init /\ [][Next]_vars

\* --- Rules ---
\* At most one steerer holds the turn.
OneSteerer == Cardinality(holders) <= 1
\* While one person holds the turn, nobody else's message reaches the running agent.
NoIntrusion == ~intruded
\* A queued message never enters a running turn.
QueueWaitsForTurnEnd ==
  \A h \in Humans : (msg[h] = "started" /\ kind[h] = "queue") => turn = "idle"
\* Only the holder, or the owner when nobody holds the turn, answers a prompt.
AnswerByHolderOrOwner == ~badAnswer
\* Deliveries to one session are single flight.
OneInFlight == Cardinality({h \in Humans : msg[h] = "started"}) <= 1
====
