---- MODULE TurnBaton ----
\* Decision qd7590f: one person holds the turn. Pressing Enter takes the turn when
\* nobody holds it; otherwise the message waits. The owner may take the turn from a
\* teammate, but (Guarded) never while the teammate's message is on its way.
EXTENDS Naturals, FiniteSets
CONSTANT Guarded
People == {"you", "mate"}          \* "you" own the session
VARIABLES baton, msg, turn, got, intruded, ownerTook
vars == <<baton, msg, turn, got, intruded, ownerTook>>

Init == /\ baton = "free" /\ msg = [p \in People |-> "draft"] /\ turn = "idle"
        /\ got = [p \in People |-> 0] /\ intruded = FALSE /\ ownerTook = FALSE

PressEnter(p) == msg[p] = "draft"
  /\ (IF baton = p \/ (baton = "free" /\ turn = "idle")
       THEN baton' = p /\ msg' = [msg EXCEPT ![p] = "inflight"]
       ELSE UNCHANGED baton /\ msg' = [msg EXCEPT ![p] = "waiting"])
  /\ UNCHANGED <<turn, got, intruded, ownerTook>>
TakeFreeTurn(p) == msg[p] = "waiting" /\ baton = "free" /\ turn = "idle"
  /\ baton' = p /\ msg' = [msg EXCEPT ![p] = "inflight"]
  /\ UNCHANGED <<turn, got, intruded, ownerTook>>
SendWhileHolding(p) == msg[p] = "waiting" /\ baton = p
  /\ msg' = [msg EXCEPT ![p] = "inflight"]
  /\ UNCHANGED <<baton, turn, got, intruded, ownerTook>>
Lands(p) == msg[p] = "inflight"
  /\ msg' = [msg EXCEPT ![p] = "landed"] /\ got' = [got EXCEPT ![p] = @ + 1]
  /\ turn' = "working" /\ intruded' = (intruded \/ baton # p)
  /\ UNCHANGED <<baton, ownerTook>>
TurnEnds == turn = "working" /\ \A p \in People : msg[p] # "inflight"
  /\ turn' = "idle" /\ baton' = "free"
  /\ UNCHANGED <<msg, got, intruded, ownerTook>>
OwnerTakesTurn == baton = "mate" /\ ~ownerTook
  /\ (Guarded => msg["mate"] # "inflight")
  /\ baton' = "you" /\ ownerTook' = TRUE
  /\ UNCHANGED <<msg, turn, got, intruded>>
Done == (\A p \in People : msg[p] = "landed") /\ turn = "idle" /\ UNCHANGED vars

Next == \/ \E p \in People : PressEnter(p) \/ TakeFreeTurn(p) \/ SendWhileHolding(p) \/ Lands(p)
        \/ TurnEnds \/ OwnerTakesTurn \/ Done
Spec == Init /\ [][Next]_vars

NoIntrusion == ~intruded
OneSteerAtATime == Cardinality({p \in People : msg[p] = "inflight"}) <= 1
NeverDeliveredTwice == \A p \in People : got[p] <= 1
OnlyHolderSends == \A p \in People : msg[p] = "inflight" => baton = p
====
