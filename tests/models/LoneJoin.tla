---- MODULE LoneJoin ----
(* Ana works alone with no claim row. Ben joins at any time. Ana's right to drive
   is implied by the turn she started. The first time Ben presses Enter in that
   turn, the server writes Ana's claim row with a lease, and Ben's message queues.
   Ana's client renews the lease while she is there. When she is gone it lapses. *)
EXTENDS Naturals

CONSTANTS
  Implied,   \* the server honors the right that the turn implies
  EagerRow,  \* a lone sender writes a claim row
  Lapses     \* a claim row can lapse

Humans == {"ana", "ben"}
VARIABLES here, row, turn, starter, conv, msg, writesAlone, tried, intruded, rounds
vars == <<here, row, turn, starter, conv, msg, writesAlone, tried, intruded, rounds>>
\* conv: the implied right of this turn became a row, or was not needed
\* msg[h]: none | want | flight | queued

Init ==
  /\ here = {"ana"} /\ row = "none" /\ turn = "idle" /\ starter = "none" /\ conv = FALSE
  /\ msg = [h \in Humans |-> "none"] /\ writesAlone = 0 /\ tried = FALSE
  /\ intruded = FALSE /\ rounds = 0

Other(h) == IF h = "ana" THEN "ben" ELSE "ana"
ImpliedRight(h) == turn = "running" /\ starter = h /\ ~conv
Right(h) == row = h \/ (row = "none" /\ ImpliedRight(h))

Join == /\ "ben" \notin here /\ here' = here \cup {"ben"}
        /\ UNCHANGED <<row, turn, starter, conv, msg, writesAlone, tried, intruded, rounds>>
Leave(h) == /\ h \in here /\ here' = here \ {h}
            /\ UNCHANGED <<row, turn, starter, conv, msg, writesAlone, tried, intruded, rounds>>

\* A message starts a turn when none runs. This writes no claim row.
StartTurn(h) ==
  /\ h \in here /\ turn = "idle" /\ rounds < 2 /\ msg[Other(h)] # "flight"
  /\ row \in {"none", h}
  /\ turn' = "running" /\ starter' = h /\ conv' = FALSE /\ rounds' = rounds + 1
  /\ row' = IF EagerRow THEN h ELSE row
  /\ writesAlone' = IF EagerRow /\ ~tried THEN 1 ELSE writesAlone
  /\ UNCHANGED <<here, msg, tried, intruded>>

Press(h) ==
  /\ h \in here /\ turn = "running" /\ msg[h] = "none"
  /\ msg' = [msg EXCEPT ![h] = "want"]
  /\ UNCHANGED <<here, row, turn, starter, conv, writesAlone, tried, intruded, rounds>>

\* The server handles the press in one transaction.
Serve(h) ==
  LET o == Other(h) IN
  /\ msg[h] = "want"
  /\ IF turn = "idle" THEN
       /\ msg' = [msg EXCEPT ![h] = "queued"] /\ UNCHANGED <<row, conv, tried, intruded>>
     ELSE IF Right(h) /\ msg[o] # "flight" THEN
       /\ msg' = [msg EXCEPT ![h] = "flight"] /\ UNCHANGED <<row, conv, tried, intruded>>
     ELSE IF row = "none" /\ Implied /\ ImpliedRight(o) THEN
       /\ row' = o /\ conv' = TRUE /\ tried' = TRUE
       /\ msg' = [msg EXCEPT ![h] = "queued"] /\ UNCHANGED intruded
     ELSE IF row = "none" /\ msg[o] # "flight" THEN
       /\ row' = h /\ conv' = TRUE /\ tried' = TRUE
       /\ msg' = [msg EXCEPT ![h] = "flight"]
       /\ intruded' = (intruded \/ ImpliedRight(o))
     ELSE
       /\ tried' = TRUE /\ msg' = [msg EXCEPT ![h] = "queued"] /\ UNCHANGED <<row, conv, intruded>>
  /\ UNCHANGED <<here, turn, starter, writesAlone, rounds>>

\* The person asks again for a queued message: "steer now".
Again(h) ==
  /\ h \in here /\ turn = "running" /\ msg[h] = "queued" /\ row \in {"none", h}
  /\ msg' = [msg EXCEPT ![h] = "want"]
  /\ UNCHANGED <<here, row, turn, starter, conv, writesAlone, tried, intruded, rounds>>

Land(h) ==
  /\ msg[h] = "flight"
  /\ msg' = [msg EXCEPT ![h] = "none"]
  /\ intruded' = (intruded \/ (turn = "running" /\ Right(Other(h))))
  /\ UNCHANGED <<here, row, turn, starter, conv, writesAlone, tried, rounds>>

\* A holder that is gone can not renew. A holder that is here can also let go.
Lapse ==
  /\ Lapses /\ row # "none"
  /\ row' = "none" /\ conv' = TRUE
  /\ UNCHANGED <<here, turn, starter, msg, writesAlone, tried, intruded, rounds>>

TurnEnds ==
  /\ turn = "running"
  /\ turn' = "idle" /\ starter' = "none" /\ conv' = FALSE
  /\ UNCHANGED <<here, row, msg, writesAlone, tried, intruded, rounds>>

Next == Join \/ Lapse \/ TurnEnds
        \/ \E h \in Humans : Leave(h) \/ StartTurn(h) \/ Press(h) \/ Serve(h) \/ Again(h) \/ Land(h)
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Lapse /\ row \notin here) /\ \A h \in Humans :
              WF_vars(Serve(h)) /\ WF_vars(Again(h)) /\ WF_vars(Land(h))

OneHolder == row \in Humans \cup {"none"}
NoIntrusion == ~intruded
\* No claim write until a second person asked to steer.
ZeroWritesAlone == writesAlone = 0
\* If Ana is gone for good and Ben stays, Ben does not wait for the turn to end.
GoneHolderFreesBaton ==
  []((msg["ben"] = "queued" /\ turn = "running" /\ "ana" \notin here /\ "ben" \in here)
     => <>(msg["ben"] # "queued" \/ turn = "idle" \/ "ben" \notin here \/ "ana" \in here))
====
