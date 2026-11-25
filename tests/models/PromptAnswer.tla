---- MODULE PromptAnswer ----
(* Who answers an agent's prompt, and which prompt the answer reaches.
   ana owns the session. ben can hold the turn baton. The agent opens
   prompts. A routine prompt is for the baton holder, or for the owner
   when nobody holds the baton. An escalation (disk, secrets, deploys,
   spend) is for the owner only.
   An answer names the prompt it is for: the prompt id and the run epoch
   (`expected`). The server accepts one answer for each prompt and checks
   the sender's role at that moment. The machine compares the prompt again,
   immediately before it gives the answer to the agent.
   Prompt ids start again at 1 after the agent restarts in a new epoch.
   The model does not trust the client: any person can send an answer for
   the prompt card that they see. *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  ServerGuard,    \* TRUE: the server accepts an answer only for the open prompt it names, once
  MachineGuard,   \* TRUE: the machine gives an answer to the agent only for the prompt it names
  EpochInGuard,   \* TRUE: the guards compare the run epoch as well as the prompt id
  RoleCheck,      \* TRUE: the server checks the sender's role when it accepts the answer
  OwnerFallback,  \* TRUE: the owner answers a routine prompt when nobody holds the baton
  MaxPrompt,      \* model bound: prompts in one epoch
  MaxEpoch        \* model bound: run epochs

People == {"ana", "ben"}
Owner == "ana"
Classes == {"routine", "escalation"}

VARIABLES
  holder,     \* server: who holds the turn baton (none | ana | ben)
  epoch,      \* machine: the run epoch of the agent process
  nextId,     \* agent: the last prompt id it used in this epoch
  aId,        \* agent: the id of its open prompt (0 = none)
  aClass,     \* agent: the class of its open prompt
  sId,        \* server: the prompt on the card (0 = no card yet)
  sClass,     \* server: its class
  sEp,        \* server: its epoch
  sStatus,    \* server: none | open | answered | closed
  rqId,       \* per person: the prompt id of an answer on its way to the server (0 = none)
  rqEp,       \* per person: the epoch that answer names
  cmds,       \* answers the server accepted, on their way to the machine
  settled,    \* prompts (id, epoch) that have an accepted answer
  twice,      \* the server accepted a second answer for one prompt
  later,      \* an answer reached a prompt that it did not name
  nonOwner,   \* someone other than the owner answered an escalation
  notAllowed  \* the server accepted an answer from a person not allowed to answer

vars == <<holder, epoch, nextId, aId, aClass, sId, sClass, sEp, sStatus,
          rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

Init ==
  /\ holder = "none" /\ epoch = 1 /\ nextId = 0 /\ aId = 0 /\ aClass = "routine"
  /\ sId = 0 /\ sClass = "routine" /\ sEp = 1 /\ sStatus = "none"
  /\ rqId = [h \in People |-> 0] /\ rqEp = [h \in People |-> 1]
  /\ cmds = {} /\ settled = {}
  /\ twice = FALSE /\ later = FALSE /\ nonOwner = FALSE /\ notAllowed = FALSE

\* Who can answer a prompt of class c now.
Allowed(h, c) ==
  IF c = "escalation"
    THEN h = Owner
    ELSE h = holder \/ (OwnerFallback /\ holder = "none" /\ h = Owner)

\* --- The baton ---
Take(h) ==
  /\ holder = "none" /\ holder' = h
  /\ UNCHANGED <<epoch, nextId, aId, aClass, sId, sClass, sEp, sStatus, rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

\* The holder leaves, or the lease runs out.
Release ==
  /\ holder # "none" /\ holder' = "none"
  /\ UNCHANGED <<epoch, nextId, aId, aClass, sId, sClass, sEp, sStatus, rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

OwnerTakes ==
  /\ holder = "ben" /\ holder' = Owner
  /\ UNCHANGED <<epoch, nextId, aId, aClass, sId, sClass, sEp, sStatus, rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

\* --- The agent ---
AgentOpens(c) ==
  /\ aId = 0 /\ nextId < MaxPrompt
  /\ nextId' = nextId + 1 /\ aId' = nextId + 1 /\ aClass' = c
  /\ UNCHANGED <<holder, epoch, sId, sClass, sEp, sStatus, rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

\* The prompt closes with no answer: the turn stops, or the prompt times out.
AgentCloses ==
  /\ aId # 0 /\ aId' = 0
  /\ UNCHANGED <<holder, epoch, nextId, aClass, sId, sClass, sEp, sStatus, rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

\* The agent process restarts: a new epoch, no open prompt, ids from 1 again.
AgentRestarts ==
  /\ epoch < MaxEpoch
  /\ epoch' = epoch + 1 /\ aId' = 0 /\ nextId' = 0
  /\ UNCHANGED <<holder, aClass, sId, sClass, sEp, sStatus, rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

\* --- The server's prompt card follows the machine's events, in order ---
ServerLearns ==
  /\ \/ aId # 0 /\ (sId # aId \/ sEp # epoch)
     \/ aId = 0 /\ sStatus \in {"open", "answered"}
  /\ IF aId # 0
       THEN sId' = aId /\ sClass' = aClass /\ sEp' = epoch /\ sStatus' = "open"
       ELSE sStatus' = "closed" /\ UNCHANGED <<sId, sClass, sEp>>
  /\ UNCHANGED <<holder, epoch, nextId, aId, aClass, rqId, rqEp, cmds, settled, twice, later, nonOwner, notAllowed>>

\* --- An answer ---
\* A person presses an answer on the card. The answer names the card's prompt.
Press(h) ==
  /\ sStatus = "open" /\ rqId[h] = 0
  /\ rqId' = [rqId EXCEPT ![h] = sId] /\ rqEp' = [rqEp EXCEPT ![h] = sEp]
  /\ UNCHANGED <<holder, epoch, nextId, aId, aClass, sId, sClass, sEp, sStatus, cmds, settled, twice, later, nonOwner, notAllowed>>

NamesTheCard(h) == rqId[h] = sId /\ (EpochInGuard => rqEp[h] = sEp)

ServerTakesAnswer(h) ==
  /\ rqId[h] # 0
  /\ IF /\ ServerGuard => (sStatus = "open" /\ NamesTheCard(h))
        /\ RoleCheck => Allowed(h, sClass)
       THEN /\ cmds' = cmds \cup {[id |-> rqId[h], ep |-> rqEp[h], by |-> h]}
            /\ settled' = settled \cup {<<rqId[h], rqEp[h]>>}
            /\ twice' = (twice \/ <<rqId[h], rqEp[h]>> \in settled)
            /\ notAllowed' = (notAllowed \/ ~Allowed(h, sClass))
            /\ sStatus' = IF sStatus = "open" /\ NamesTheCard(h) THEN "answered" ELSE sStatus
       ELSE UNCHANGED <<cmds, settled, twice, notAllowed, sStatus>>   \* refused: the card shows who answered, or who can answer
  /\ rqId' = [rqId EXCEPT ![h] = 0]
  /\ UNCHANGED <<holder, epoch, nextId, aId, aClass, sId, sClass, sEp, rqEp, later, nonOwner>>

NamesTheOpenPrompt(c) == c.id = aId /\ (EpochInGuard => c.ep = epoch)

MachineTakesAnswer(c) ==
  /\ c \in cmds
  /\ cmds' = cmds \ {c}
  /\ IF aId # 0 /\ (MachineGuard => NamesTheOpenPrompt(c))
       THEN /\ aId' = 0   \* the agent has its answer
            /\ later' = (later \/ c.id # aId \/ c.ep # epoch)
            /\ nonOwner' = (nonOwner \/ (aClass = "escalation" /\ c.by # Owner))
       ELSE UNCHANGED <<aId, later, nonOwner>>   \* stale: the answer is dropped and reported
  /\ UNCHANGED <<holder, epoch, nextId, aClass, sId, sClass, sEp, sStatus, rqId, rqEp, settled, twice, notAllowed>>

Next ==
  \/ \E h \in People : Take(h) \/ Press(h) \/ ServerTakesAnswer(h)
  \/ Release \/ OwnerTakes
  \/ \E c \in Classes : AgentOpens(c)
  \/ AgentCloses \/ AgentRestarts \/ ServerLearns
  \/ \E h \in People, i \in 1..MaxPrompt, e \in 1..MaxEpoch :
       MachineTakesAnswer([id |-> i, ep |-> e, by |-> h])

Spec == Init /\ [][Next]_vars

\* --- Rules ---
\* At most one answer takes effect for a prompt: the server settles a prompt once.
OneAnswerSettles == ~twice
\* An answer never reaches a prompt that it did not name.
NeverALaterPrompt == ~later
\* An escalation is never answered by someone other than the owner.
EscalationOnlyByOwner == ~nonOwner
\* The server accepts an answer only from a person allowed to answer at that moment.
OnlyAllowedPersonAnswers == ~notAllowed
\* Every open prompt has someone allowed to answer it.
SomeoneCanAnswer == sStatus = "open" => \E h \in People : Allowed(h, sClass)
====
