---- MODULE Lease ----
(* One piece of ready work and two agent sessions that may claim it.
   The server is the only writer of the work's status. A claim returns a
   fencing token; every later write (progress, complete) names the token
   and is accepted only while that token is the current one. A lease that
   runs out does not change the token: the work becomes claimable, and the
   next claim mints a new token, which is what shuts the old holder out. *)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxToken

Workers == {"w1", "w2"}

VARIABLES
  item,     \* server: ready | held | done
  token,    \* server: the current fencing token (grows with each claim)
  live,     \* server: the lease has not run out
  mine,     \* per worker: the token it believes it holds (0 = none)
  done      \* how many completions the server accepted

vars == <<item, token, live, mine, done>>

Init ==
  /\ item = "ready" /\ token = 0 /\ live = FALSE
  /\ mine = [w \in Workers |-> 0] /\ done = 0

Claimable == item = "ready" \/ (item = "held" /\ ~live)

\* Ready work, or work whose lease ran out, goes to whoever asks first.
Claim(w) ==
  /\ Claimable /\ mine[w] = 0 /\ token < MaxToken
  /\ item' = "held" /\ token' = token + 1 /\ live' = TRUE
  /\ mine' = [mine EXCEPT ![w] = token + 1]
  /\ UNCHANGED done

\* The holder renews in time (also revives a lapsed lease nobody re-claimed).
Renew(w) ==
  /\ item = "held" /\ mine[w] = token /\ ~live
  /\ live' = TRUE
  /\ UNCHANGED <<item, token, mine, done>>

\* The holder goes silent past its lease.
LeaseRunsOut ==
  /\ item = "held" /\ live
  /\ live' = FALSE
  /\ UNCHANGED <<item, token, mine, done>>

\* A worker reports completion. The server compares tokens.
Complete(w) ==
  /\ mine[w] # 0
  /\ IF item = "held" /\ mine[w] = token
       THEN /\ item' = "done" /\ done' = done + 1 /\ live' = FALSE
            /\ mine' = [mine EXCEPT ![w] = 0]
            /\ UNCHANGED token
       ELSE /\ mine' = [mine EXCEPT ![w] = 0]   \* refused: the worker learns it lost the work
            /\ UNCHANGED <<item, token, live, done>>

\* The holder gives the work back.
GiveBack(w) ==
  /\ item = "held" /\ mine[w] = token
  /\ item' = "ready" /\ live' = FALSE
  /\ mine' = [mine EXCEPT ![w] = 0]
  /\ UNCHANGED <<token, done>>

Finished ==
  /\ item = "done" /\ \A w \in Workers : mine[w] = 0
  /\ UNCHANGED vars

\* Model bound: the token counter is exhausted and nobody holds the work.
OutOfTokens ==
  /\ token = MaxToken /\ item # "done" /\ \A w \in Workers : mine[w] = 0
  /\ UNCHANGED vars

Next ==
  \/ \E w \in Workers : Claim(w) \/ Renew(w) \/ Complete(w) \/ GiveBack(w)
  \/ LeaseRunsOut \/ Finished \/ OutOfTokens

Spec == Init /\ [][Next]_vars

\* --- Rules ---
\* At most one session holds a valid claim on the work.
OneValidHolder == Cardinality({w \in Workers : item = "held" /\ mine[w] = token}) <= 1
\* The work is completed at most once.
CompletedOnce == done <= 1
\* An expired lease frees the work: another session can claim it.
ExpiredLeaseFreesWork ==
  (item = "held" /\ ~live /\ token < MaxToken) =>
    \A w \in Workers : (mine[w] = 0 => ENABLED Claim(w))
\* At most one session is working on the item at any moment.
OneSessionWorking == Cardinality({w \in Workers : mine[w] # 0}) <= 1
====
