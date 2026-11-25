---- MODULE TerminalControl ----
(* Who can type into a session's terminal pane on another person's machine.
   ana owns the machine. ben is a teammate who watches the pane. Typing is a
   separate grant from ana, off at the start. One person at a time holds the
   typing lease, a claim on session:<id>:terminal with a fencing token.
   Each input names the pane instance and the token (`expected`).
   The server tells the machine which token types now, in control messages
   with a sequence number. The machine compares each input with the token
   and the pane that it holds, immediately before it types.
   The network can deliver control messages late and in a different order.
   The machine reports the token that it accepts. A client sends keys only
   after that report names its token.
   A client that lost the lease can continue to send with its old token.
   The pane can restart: a new pane instance is a different program. *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  ServerCheck,        \* TRUE: each input goes through the server, which checks holder, token and pane
  MachineTokenCheck,  \* TRUE: the machine types an input only when it names the token the machine holds
  PaneCheck,          \* TRUE: the lease, the control messages and the inputs are tied to one pane instance
  MonotonicControl,   \* TRUE: the machine ignores a control message older than one it applied
  WaitForAck,         \* TRUE: a client sends keys only after the machine reported that it accepts the client's token
  MaxToken,           \* model bound: how many times the lease can be claimed
  MaxPane             \* model bound: pane instances

People == {"ana", "ben"}
Owner == "ana"

VARIABLES
  grant,      \* server: ben has the typing grant
  holders,    \* server: who holds the typing lease (a set, to check it stays <= 1)
  sToken,     \* server: the last fencing token it made
  sPane,      \* server: the pane instance it knows from terminal.started (0 = none)
  seq,        \* server: the sequence number of its last control message
  ctl,        \* control messages on their way to the machine
  cToken,     \* per person: the token their client believes it holds (0 = none)
  cPane,      \* per person: the pane instance their client shows
  iStage,     \* per person: one input: none | sent | passed
  iToken,     \* per person: the token that input names
  iPane,      \* per person: the pane instance that input names
  mPane,      \* machine: the pane instance that runs now
  mToken,     \* machine: the token whose input it types (0 = none)
  mSeq,       \* machine: the highest control sequence number it applied
  ackTok,     \* the token the machine last reported that it accepts (can be behind the machine)
  ended,      \* machine: tokens it stopped
  revoked,    \* machine: tokens whose revoke it acknowledged
  staleTyped, \* an input reached the pane with a token the machine did not hold
  wrongPane,  \* an input reached a pane instance that it did not name
  afterRevoke,\* an input reached the pane after the machine acknowledged the revoke of its token
  droppedLive \* the machine dropped an input from the person who holds the lease on the pane that runs

vars == <<grant, holders, sToken, sPane, seq, ctl, cToken, cPane, iStage, iToken, iPane,
          mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

Init ==
  /\ grant = FALSE /\ holders = {} /\ sToken = 0 /\ sPane = 0 /\ seq = 0 /\ ctl = {}
  /\ cToken = [h \in People |-> 0] /\ cPane = [h \in People |-> 0]
  /\ iStage = [h \in People |-> "none"] /\ iToken = [h \in People |-> 0] /\ iPane = [h \in People |-> 0]
  /\ mPane = 1 /\ mToken = 0 /\ mSeq = 0 /\ ackTok = 0 /\ ended = {} /\ revoked = {}
  /\ staleTyped = FALSE /\ wrongPane = FALSE /\ afterRevoke = FALSE /\ droppedLive = FALSE

\* `upto` is the highest token made when the server sent the message: a machine
\* that applies the message stops every token up to it, but not the token it names.
Control(token, revokes, upto) ==
  [seq |-> seq + 1, token |-> token, pane |-> sPane, revokes |-> revokes, upto |-> upto]

\* --- The owner's grant ---
OwnerGrants ==
  /\ ~grant /\ grant' = TRUE
  /\ UNCHANGED <<holders, sToken, sPane, seq, ctl, cToken, cPane, iStage, iToken, iPane, mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* The owner removes the grant. If ben types now, his lease ends at once.
OwnerRevokes ==
  /\ grant /\ grant' = FALSE
  /\ IF "ben" \in holders
       THEN /\ holders' = {} /\ seq' = seq + 1
            /\ ctl' = ctl \cup {Control(0, sToken, sToken)}
       ELSE UNCHANGED <<holders, seq, ctl>>
  /\ UNCHANGED <<sToken, sPane, cToken, cPane, iStage, iToken, iPane, mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* --- The typing lease ---
Claim(h) ==
  /\ holders = {} /\ (h = Owner \/ grant) /\ sPane # 0 /\ sToken < MaxToken
  /\ holders' = {h} /\ sToken' = sToken + 1 /\ seq' = seq + 1
  /\ ctl' = ctl \cup {Control(sToken + 1, 0, sToken + 1)}
  /\ cToken' = [cToken EXCEPT ![h] = sToken + 1] /\ cPane' = [cPane EXCEPT ![h] = sPane]
  /\ UNCHANGED <<grant, sPane, iStage, iToken, iPane, mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* The typist leaves the pane, loses the connection, or the lease runs out.
\* A client that lost the connection continues to believe that it holds the token.
Release(h) ==
  /\ h \in holders
  /\ holders' = {} /\ seq' = seq + 1
  /\ ctl' = ctl \cup {Control(0, 0, sToken)}
  /\ UNCHANGED <<grant, sToken, sPane, cToken, cPane, iStage, iToken, iPane, mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* --- The pane ---
\* The program in the pane ends and a new one starts. With PaneCheck the
\* machine stops the token itself: a lease is for one pane instance.
PaneRestarts ==
  /\ mPane < MaxPane /\ mPane' = mPane + 1
  /\ IF PaneCheck
       THEN mToken' = 0 /\ ended' = ended \cup ({mToken} \ {0})
       ELSE UNCHANGED <<mToken, ended>>
  /\ UNCHANGED <<grant, holders, sToken, sPane, seq, ctl, cToken, cPane, iStage, iToken, iPane, mSeq, ackTok, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* terminal.ended and terminal.started arrive. The lease on the old pane ends.
ServerLearnsPane ==
  /\ sPane # mPane
  /\ sPane' = mPane /\ holders' = {}
  /\ UNCHANGED <<grant, sToken, seq, ctl, cToken, cPane, iStage, iToken, iPane, mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* --- Control messages reach the machine, in any order ---
MachineApplies(c) ==
  /\ c \in ctl /\ ctl' = ctl \ {c}
  /\ IF (MonotonicControl => c.seq > mSeq) /\ (PaneCheck => c.pane = mPane)
       THEN /\ mToken' = c.token
            /\ mSeq' = IF c.seq > mSeq THEN c.seq ELSE mSeq
            /\ ended' = ended \cup ((1..c.upto) \ {c.token})
            /\ revoked' = revoked \cup ({c.revokes} \ {0})
       ELSE UNCHANGED <<mToken, mSeq, ended, revoked>>
  /\ UNCHANGED <<grant, holders, sToken, sPane, seq, cToken, cPane, iStage, iToken, iPane, mPane, ackTok, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* --- One input from each person ---
Type(h) ==
  /\ cToken[h] # 0 /\ iStage[h] = "none"
  /\ WaitForAck => ackTok = cToken[h]
  /\ iStage' = [iStage EXCEPT ![h] = "sent"]
  /\ iToken' = [iToken EXCEPT ![h] = cToken[h]] /\ iPane' = [iPane EXCEPT ![h] = cPane[h]]
  /\ UNCHANGED <<grant, holders, sToken, sPane, seq, ctl, cToken, cPane, mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* The server passes the input, or refuses it and tells the client.
ServerPasses(h) ==
  /\ iStage[h] = "sent"
  /\ IF ServerCheck => (h \in holders /\ iToken[h] = sToken /\ iPane[h] = sPane)
       THEN iStage' = [iStage EXCEPT ![h] = "passed"] /\ UNCHANGED cToken
       ELSE iStage' = [iStage EXCEPT ![h] = "none"] /\ cToken' = [cToken EXCEPT ![h] = 0]
  /\ UNCHANGED <<grant, holders, sToken, sPane, seq, ctl, cPane, iToken, iPane, mPane, mToken, mSeq, ackTok, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

\* The machine types the input into the pane, or drops it.
MachineTypes(h) ==
  /\ iStage[h] = "passed"
  /\ iStage' = [iStage EXCEPT ![h] = "none"]
  /\ IF (MachineTokenCheck => iToken[h] = mToken) /\ (PaneCheck => iPane[h] = mPane)
       THEN /\ staleTyped' = (staleTyped \/ iToken[h] # mToken)
            /\ wrongPane' = (wrongPane \/ iPane[h] # mPane)
            /\ afterRevoke' = (afterRevoke \/ iToken[h] \in revoked)
            /\ UNCHANGED <<cToken, droppedLive>>
       ELSE /\ cToken' = [cToken EXCEPT ![h] = 0]   \* dropped: the client learns that it does not type
            /\ droppedLive' = (droppedLive \/ (h \in holders /\ iToken[h] = sToken
                                              /\ iPane[h] = sPane /\ sPane = mPane))
            /\ UNCHANGED <<staleTyped, wrongPane, afterRevoke>>
  /\ UNCHANGED <<grant, holders, sToken, sPane, seq, ctl, cPane, iToken, iPane, mPane, mToken, mSeq, ackTok, ended, revoked>>

\* The machine's report of the token it accepts arrives.
AckArrives ==
  /\ ackTok # mToken /\ ackTok' = mToken
  /\ UNCHANGED <<grant, holders, sToken, sPane, seq, ctl, cToken, cPane, iStage, iToken, iPane, mPane, mToken, mSeq, ended, revoked, staleTyped, wrongPane, afterRevoke, droppedLive>>

Next ==
  \/ OwnerGrants \/ OwnerRevokes \/ PaneRestarts \/ ServerLearnsPane
  \/ \E h \in People : Claim(h) \/ Release(h) \/ Type(h) \/ ServerPasses(h) \/ MachineTypes(h)
  \/ \E s \in 1..(3 * MaxToken), t \in 0..MaxToken, p \in 0..MaxPane, r \in 0..MaxToken, u \in 0..MaxToken :
       MachineApplies([seq |-> s, token |-> t, pane |-> p, revokes |-> r, upto |-> u])
  \/ AckArrives

Spec == Init /\ [][Next]_vars

\* --- Rules ---
\* At most one person holds the typing lease.
OneTypist == Cardinality(holders) <= 1
\* Only input that names the token the machine holds reaches the pane.
OnlyCurrentTokenTypes == ~staleTyped
\* No input reaches a pane instance that replaced the one it names.
NoInputToReplacedPane == ~wrongPane
\* No input reaches the pane after the machine acknowledged the revoke of its token.
NoInputAfterRevokeAck == ~afterRevoke
\* The machine never types again for a token that it stopped.
StoppedTokenStaysStopped == mToken \notin ended
\* The machine never drops input from the person who holds the lease on the pane that runs.
HolderInputNotDropped == ~droppedLive
====
