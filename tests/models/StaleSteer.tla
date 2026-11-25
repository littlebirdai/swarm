---- MODULE StaleSteer ----
(* One person acts on the turn that they see: a steer (Enter) or an
   interrupt (Stop). The action carries `expected`, the id of that turn.
   The agent can end the turn, and another message can start a later turn,
   before the action arrives. The server compares `expected` with the turn
   that it knows. The machine compares it again, immediately before the
   effect, with the turn that runs.
   A stale steer is not delivered: the composer keeps the text and offers
   Queue. A stale interrupt does nothing.
   The baton is in CoSteer.tla and delivery is in Delivery.tla. *)
EXTENDS Naturals

CONSTANTS
  ServerGuard,    \* TRUE: the server refuses an action whose expected turn is not the turn it knows
  MachineGuard,   \* TRUE: the machine refuses an action whose expected turn is not the turn that runs
  MaxTurn         \* model bound: how many turns other messages can start

VARIABLES
  turn,       \* machine: the id of the turn that runs now (0 = no turn)
  last,       \* machine: the highest turn id it used
  sTurn,      \* server: the turn it knows from the event log (can be behind the machine)
  kind,       \* none | steer | interrupt
  expected,   \* the turn the person saw when they pressed the key
  act,        \* none | sent | started | applied | offered | noop
  wrongTurn,  \* the action changed a turn that its sender did not see
  wrongStop   \* the action was refused as stale while the turn its sender saw still ran

vars == <<turn, last, sTurn, kind, expected, act, wrongTurn, wrongStop>>

Init ==
  /\ turn = 0 /\ last = 0 /\ sTurn = 0
  /\ kind = "none" /\ expected = 0 /\ act = "none"
  /\ wrongTurn = FALSE /\ wrongStop = FALSE

\* A message from the shared queue starts the next turn.
TurnStarts ==
  /\ turn = 0 /\ last < MaxTurn
  /\ turn' = last + 1 /\ last' = last + 1
  /\ UNCHANGED <<sTurn, kind, expected, act, wrongTurn, wrongStop>>

TurnEnds ==
  /\ turn # 0
  /\ turn' = 0
  /\ UNCHANGED <<last, sTurn, kind, expected, act, wrongTurn, wrongStop>>

\* The machine's turn events arrive at the server, in order.
ServerLearns ==
  /\ sTurn # turn
  /\ sTurn' = turn
  /\ UNCHANGED <<turn, last, kind, expected, act, wrongTurn, wrongStop>>

\* The person sees a running turn and presses Enter or Stop.
Press(k) ==
  /\ act = "none" /\ sTurn # 0
  /\ kind' = k /\ expected' = sTurn /\ act' = "sent"
  /\ UNCHANGED <<turn, last, sTurn, wrongTurn, wrongStop>>

Refused == IF kind = "steer" THEN "offered" ELSE "noop"

\* The server starts the action. A permit or command carries `expected`.
ServerStarts ==
  /\ act = "sent"
  /\ IF ServerGuard /\ expected # sTurn
       THEN /\ act' = Refused
            /\ wrongStop' = (wrongStop \/ expected = turn)
       ELSE /\ act' = "started"
            /\ UNCHANGED wrongStop
  /\ UNCHANGED <<turn, last, sTurn, kind, expected, wrongTurn>>

\* The machine acts on the permit or command.
MachineActs ==
  /\ act = "started"
  /\ IF MachineGuard /\ expected # turn
       THEN /\ act' = Refused
            /\ UNCHANGED <<turn, last, wrongTurn>>
       ELSE /\ act' = "applied"
            /\ wrongTurn' = (wrongTurn \/ (kind = "steer" /\ turn # expected)
                                       \/ (kind = "interrupt" /\ turn # 0 /\ turn # expected))
            /\ IF kind = "steer"
                 THEN IF turn = 0
                        THEN turn' = last + 1 /\ last' = last + 1   \* the steer starts a turn nobody asked for
                        ELSE UNCHANGED <<turn, last>>               \* the steer enters the turn that runs
                 ELSE turn' = 0 /\ UNCHANGED last                   \* the interrupt stops the turn that runs
  /\ UNCHANGED <<sTurn, kind, expected, wrongStop>>

Finished ==
  /\ act \in {"applied", "offered", "noop"} /\ turn = 0 /\ sTurn = 0 /\ last >= MaxTurn
  /\ UNCHANGED vars

\* Nobody pressed a key, and no more turns start.
Quiet ==
  /\ act = "none" /\ turn = 0 /\ sTurn = 0 /\ last >= MaxTurn
  /\ UNCHANGED vars

Next ==
  \/ TurnStarts \/ TurnEnds \/ ServerLearns
  \/ \E k \in {"steer", "interrupt"} : Press(k)
  \/ ServerStarts \/ MachineActs \/ Finished \/ Quiet

Spec == Init /\ [][Next]_vars

\* --- Rules ---
\* A steer or an interrupt changes only the turn that its sender saw.
ActsOnlyOnTheTurnSeen == ~wrongTurn
\* An action is refused as stale only when the turn its sender saw is over.
RefusedOnlyWhenStale == ~wrongStop
====
