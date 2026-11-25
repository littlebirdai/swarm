---- MODULE CacheHost ----
(* Two windows share one cache. The window that holds the storage lock owns a
   worker with an open file. A window can hang and later resume, or crash.
   A hung worker keeps its file open. Sign-out writes a new epoch and owner to
   the journal in one step; each window learns of it later. A worker writes
   its queue in order. A write can fail. Any host may serve reads. *)
EXTENDS Naturals, Sequences
CONSTANTS OneTxn,   \* a cursor commits with the rows it covers
          PerEpoch, \* each epoch has its own file
          StopOnFail, \* a failed batch stops the batches behind it
          Check,    \* a reader compares the file's owner and epoch with the journal
          Steal     \* a new host bumps the epoch when the old host is hung
W == {"a","b"}
NoW == "none"
Maxe == 3
MaxV == 2
F(e) == IF PerEpoch THEN e ELSE 1
VARIABLES epoch, owner, st, holder, we, wo, seen, q, rows, cur, fo, opens, bad, gap, signed
vars == <<epoch,owner,st,holder,we,wo,seen,q,rows,cur,fo,opens,bad,gap,signed>>
\* st: up|hung|dead ; we,wo: epoch and account the window acts for; seen: version in memory
\* rows,cur: versions on disk by file; fo: account of the rows; opens: worker with the file open
E == 1..Maxe
Init == /\ epoch=1 /\ owner=1 /\ st=[w \in W|->"up"] /\ holder="a" /\ we=[w \in W|->1] /\ wo=[w \in W|->1]
 /\ seen=[w \in W|->0] /\ q=[w \in W|-> <<>>] /\ rows=[e \in E|->0] /\ cur=[e \in E|->0]
 /\ fo=[e \in E|->1] /\ opens=[e \in E|->IF e=1 THEN "a" ELSE NoW] /\ bad=FALSE /\ gap=FALSE /\ signed=FALSE
Opens(w,e) == opens[F(e)]=w
Push(w) == /\ st[w]="up" /\ holder=w /\ seen[w]<MaxV /\ Len(q[w])<2 /\ Opens(w,we[w])
 /\ seen'=[seen EXCEPT ![w]=@+1]
 /\ q'=[q EXCEPT ![w]=IF OneTxn THEN Append(@,<<"both",seen[w]+1>>) ELSE Append(Append(@,<<"cur",seen[w]+1>>),<<"rows",seen[w]+1>>)]
 /\ UNCHANGED <<epoch,owner,st,holder,we,wo,rows,cur,fo,opens,bad,gap,signed>>
\* The worker runs on its own thread, so it can commit while its window hangs.
Commit(w) == /\ st[w]#"dead" /\ q[w]#<<>> /\ Opens(w,we[w])
 /\ LET b==Head(q[w]) f==F(we[w]) IN
   /\ rows'=[rows EXCEPT ![f]=IF b[1]#"cur" THEN (IF b[2]=@+1 THEN b[2] ELSE IF b[2]<=@ THEN b[2] ELSE @) ELSE @]
   /\ cur'=[cur EXCEPT ![f]=IF b[1]#"rows" THEN b[2] ELSE @]
   /\ fo'=[fo EXCEPT ![f]=IF b[1]#"cur" THEN wo[w] ELSE @]
 /\ q'=[q EXCEPT ![w]=Tail(@)]
 /\ UNCHANGED <<epoch,owner,st,holder,we,wo,seen,opens,bad,gap,signed>>
\* A failed batch. With the rule, the queue and the memory go back to the disk cursor.
Fail(w) == /\ st[w]="up" /\ q[w]#<<>> /\ Opens(w,we[w])
 /\ q'=[q EXCEPT ![w]=IF StopOnFail THEN <<>> ELSE Tail(@)]
 /\ seen'=[seen EXCEPT ![w]=IF StopOnFail THEN cur[F(we[w])] ELSE @]
 /\ UNCHANGED <<epoch,owner,st,holder,we,wo,rows,cur,fo,opens,bad,gap,signed>>
Hang(w) == st[w]="up" /\ st'=[st EXCEPT ![w]="hung"] /\ UNCHANGED <<epoch,owner,holder,we,wo,seen,q,rows,cur,fo,opens,bad,gap,signed>>
Resume(w) == st[w]="hung" /\ st'=[st EXCEPT ![w]="up"] /\ UNCHANGED <<epoch,owner,holder,we,wo,seen,q,rows,cur,fo,opens,bad,gap,signed>>
Crash(w) == /\ st[w]#"dead" /\ st'=[st EXCEPT ![w]="dead"] /\ q'=[q EXCEPT ![w]= <<>>] /\ seen'=[seen EXCEPT ![w]=0]
 /\ opens'=[e \in E|->IF opens[e]=w THEN NoW ELSE opens[e]] /\ holder'=(IF holder=w THEN NoW ELSE holder)
 /\ UNCHANGED <<epoch,owner,we,wo,rows,cur,fo,bad,gap,signed>>
Reopen(w) == /\ st[w]="dead" /\ st'=[st EXCEPT ![w]="up"] /\ we'=[we EXCEPT ![w]=epoch] /\ wo'=[wo EXCEPT ![w]=owner]
 /\ UNCHANGED <<epoch,owner,holder,seen,q,rows,cur,fo,opens,bad,gap,signed>>
SignOut == /\ ~signed /\ epoch<Maxe /\ signed'=TRUE /\ epoch'=epoch+1 /\ owner'=2
 /\ UNCHANGED <<st,holder,we,wo,seen,q,rows,cur,fo,opens,bad,gap>>
\* A live window learns of the sign-out, closes its old file and drops its queue.
Learn(w) == /\ st[w]="up" /\ we[w]#epoch /\ we'=[we EXCEPT ![w]=epoch] /\ wo'=[wo EXCEPT ![w]=owner]
 /\ q'=[q EXCEPT ![w]= <<>>] /\ seen'=[seen EXCEPT ![w]=0]
 /\ opens'=[e \in E|->IF opens[e]=w THEN NoW ELSE opens[e]] /\ holder'=(IF holder=w THEN NoW ELSE holder)
 /\ UNCHANGED <<epoch,owner,st,rows,cur,fo,bad,gap,signed>>
\* The lock is free, or a window steals it from a hung holder.
Take(w) == /\ st[w]="up" /\ we[w]=epoch /\ holder#w
 /\ (IF holder=NoW THEN TRUE ELSE Steal /\ st[holder]="hung")
 /\ LET e2==IF holder#NoW /\ opens[F(epoch)]#NoW /\ Steal THEN epoch+1 ELSE epoch
        f==F(e2) IN
   /\ e2<=Maxe /\ (opens[f]=NoW \/ ~PerEpoch)
   /\ epoch'=e2 /\ we'=[we EXCEPT ![w]=e2] /\ holder'=w
   /\ opens'=[opens EXCEPT ![f]=IF @=NoW THEN w ELSE @]
   /\ seen'=[seen EXCEPT ![w]=IF Check /\ fo[f]#wo[w] THEN 0 ELSE cur[f]] /\ q'=[q EXCEPT ![w]= <<>>]
   /\ gap'=(gap \/ rows[f]<cur[f])
   /\ bad'=(bad \/ (rows[f]>0 /\ fo[f]#wo[w] /\ ~Check))
   /\ rows'=[rows EXCEPT ![f]=IF Check /\ fo[f]#wo[w] THEN 0 ELSE @]
   /\ cur'=[cur EXCEPT ![f]=IF Check /\ fo[f]#wo[w] THEN 0 ELSE @]
   /\ fo'=[fo EXCEPT ![f]=IF Check /\ fo[f]#wo[w] THEN wo[w] ELSE @]
 /\ UNCHANGED <<owner,st,wo,signed>>
\* A live host serves reads at any time.
Serve(w) == /\ st[w]="up" /\ holder=w /\ we[w]=epoch /\ Opens(w,epoch)
 /\ LET f==F(epoch) IN bad'=(bad \/ (rows[f]>0 /\ fo[f]#owner)) /\ gap'=(gap \/ rows[f]<cur[f])
 /\ UNCHANGED <<epoch,owner,st,holder,we,wo,seen,q,rows,cur,fo,opens,signed>>
Next == SignOut \/ \E w \in W: Push(w)\/Commit(w)\/Fail(w)\/Hang(w)\/Resume(w)\/Crash(w)\/Reopen(w)\/Learn(w)\/Take(w)\/Serve(w)
Spec == Init /\ [][Next]_vars
NoSkippedRows == ~gap
NoForeignRows == ~bad
\* A reachability check: TLC must refute it, or the steal is never used.
StealNeverHappens == ~(epoch=2 /\ ~signed)
HostCanReturn == \A w \in W: ~(st[w]="up" /\ we[w]=epoch /\ holder#w /\ holder#NoW /\ st[holder]="hung" /\ epoch<Maxe /\ ~ENABLED Take(w))
HolderCanServe == holder \in W => ((st[holder]="up" /\ we[holder]=epoch) => Opens(holder,epoch))
====
