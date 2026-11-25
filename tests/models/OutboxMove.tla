---- MODULE OutboxMove ----
(* Unsent work moves from the old database to the journal in three steps: copy,
   commit, delete. The boot can crash between them. An old tab still writes and
   sends from the old database. The server can accept a send whose answer is
   lost. A person can sign out. The old database is deleted at the end. *)
EXTENDS Naturals
CONSTANTS Rescan, Dedup, BothRead, Owner, SafeDelete, Lose
A == {1,2}
VARIABLES old, cp, new, sent, typed, oldTab, oldDb, scans, build, acct, own, drop, wrong, boot, ans
vars == <<old,cp,new,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong,boot,ans>>
Init == /\ old={} /\ cp={} /\ new={} /\ sent=[a \in A|->0] /\ typed={} /\ oldTab=TRUE /\ oldDb=TRUE /\ scans=0
 /\ build="new" /\ acct=1 /\ own=[a \in A|->0] /\ drop={} /\ wrong=FALSE /\ boot=0 /\ ans={}
Put(a) == /\ typed'=typed \cup {a} /\ own'=[own EXCEPT ![a]=acct]
TypeOld(a) == /\ oldTab /\ oldDb /\ acct=1 /\ a \notin typed /\ Put(a) /\ old'=old \cup {a}
 /\ UNCHANGED <<cp,new,sent,oldTab,oldDb,scans,build,acct,drop,wrong,boot,ans>>
TypeNew(a) == /\ build="new" /\ a \notin typed /\ Put(a) /\ new'=new \cup {a}
 /\ UNCHANGED <<old,cp,sent,oldTab,oldDb,scans,build,acct,drop,wrong,boot,ans>>
Srv(a) == /\ sent'=[sent EXCEPT ![a]=IF Dedup /\ @>0 THEN @ ELSE IF @<2 THEN @+1 ELSE @]
          /\ wrong'=(wrong \/ own[a]#acct)
SendOld(a) == /\ (oldTab \/ build="old") /\ a \in old /\ acct=1 /\ <<"o",a>> \notin ans /\ Srv(a) /\ ans'=ans \cup {<<"o",a>>}
 /\ UNCHANGED <<old,cp,new,typed,oldTab,oldDb,scans,build,acct,own,drop,boot>>
AckOld(a) == /\ <<"o",a>> \in ans /\ ans'=ans \ {<<"o",a>>} /\ old'=old \ {a}
 /\ UNCHANGED <<cp,new,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong,boot>>
Scan1 == /\ build="new" /\ oldDb /\ (Rescan \/ scans=0) /\ cp={} /\ old#{} /\ cp'=old /\ scans'=1
 /\ UNCHANGED <<old,new,sent,typed,oldTab,oldDb,build,acct,own,drop,wrong,boot,ans>>
Scan0 == /\ build="new" /\ scans=0 /\ old={} /\ scans'=1 /\ UNCHANGED <<old,cp,new,sent,typed,oldTab,oldDb,build,acct,own,drop,wrong,boot,ans>>
Scan2(a) == /\ a \in cp /\ a \in old /\ a \notin new /\ new'=new \cup {a}
 /\ UNCHANGED <<old,cp,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong,boot,ans>>
Scan3(a) == /\ a \in cp /\ (a \in new \/ a \notin old \/ sent[a]>0) /\ old'=old \ {a} /\ cp'=cp \ {a}
 /\ UNCHANGED <<new,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong,boot,ans>>
CrashBoot == /\ boot<1 /\ cp#{} /\ cp'={} /\ boot'=boot+1
 /\ UNCHANGED <<old,new,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong,ans>>
CanSend(a) == a \in new /\ (build="new" \/ BothRead) /\ (Owner => own[a]=acct)
SendNew(a) == /\ CanSend(a) /\ <<"n",a>> \notin ans /\ Srv(a) /\ ans'=ans \cup {<<"n",a>>}
 /\ UNCHANGED <<old,cp,new,typed,oldTab,oldDb,scans,build,acct,own,drop,boot>>
AckNew(a) == /\ <<"n",a>> \in ans /\ ans'=ans \ {<<"n",a>>} /\ new'=new \ {a}
 /\ UNCHANGED <<old,cp,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong,boot>>
LoseAns(x) == /\ Lose /\ x \in ans /\ boot<1 /\ boot'=1 /\ ans'=ans \ {x}
 /\ UNCHANGED <<old,cp,new,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong>>
CloseOld == /\ oldTab /\ oldTab'=FALSE /\ UNCHANGED <<old,cp,new,sent,typed,oldDb,scans,build,acct,own,drop,wrong,boot,ans>>
\* A rollback is a release that has the reader; the old tab can be open.
RollBack == /\ build="new" /\ oldDb /\ build'="old" /\ cp'={} /\ UNCHANGED <<old,new,sent,typed,oldTab,oldDb,scans,acct,own,drop,wrong,boot,ans>>
DeleteDb == /\ build="new" /\ oldDb /\ (SafeDelete => (old={} /\ ~oldTab)) /\ oldDb'=FALSE /\ old'={} /\ cp'={}
 /\ UNCHANGED <<new,sent,typed,oldTab,scans,build,acct,own,drop,wrong,boot,ans>>
\* Sign-out discards unsent work of that account, as today's purge does.
\* A journal purge can be interrupted: without owner ids its leftovers are unmarked.
SignOut == /\ acct=1 /\ acct'=2 /\ drop'=drop \cup {a \in typed: sent[a]=0} /\ old'={} /\ cp'={} /\ oldTab'=FALSE
 /\ UNCHANGED <<new,sent,typed,oldDb,scans,build,own,wrong,boot,ans>>
PurgeNew(a) == /\ a \in new /\ own[a]#acct /\ new'=new \ {a} /\ UNCHANGED <<old,cp,sent,typed,oldTab,oldDb,scans,build,acct,own,drop,wrong,boot,ans>>
Next == Scan1\/Scan0\/CrashBoot\/CloseOld\/RollBack\/DeleteDb\/SignOut \/ (\E x \in ans: LoseAns(x))
  \/ \E a \in A: TypeOld(a)\/TypeNew(a)\/SendOld(a)\/AckOld(a)\/Scan2(a)\/Scan3(a)\/SendNew(a)\/AckNew(a)\/PurgeNew(a)
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Scan1) /\ WF_vars(CloseOld) /\ \A a \in A: WF_vars(Scan2(a)) /\ WF_vars(Scan3(a)) /\ WF_vars(SendNew(a)) /\ WF_vars(AckNew(a)) /\ WF_vars(SendOld(a)) /\ WF_vars(AckOld(a))
SentOnce == \A a \in A: sent[a]<=1
RightAccount == ~wrong
Arrives == \A a \in A: (a \in typed) ~> (sent[a]>0 \/ a \in drop)
====
