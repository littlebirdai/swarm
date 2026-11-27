export const ARTIFACT_COMMENT_SUBMIT_SCRIPT = `
  // One post per batch; each comment says for itself whether it goes to the
  // agent. The batch's deliver:false means an unmarked comment never does.
  var commentAttempts=new Map();
  var commentAttempt=function(key,payload){
    var fingerprint=JSON.stringify(payload),previous=commentAttempts.get(key);
    if(!previous||previous.fingerprint!==fingerprint){
      var bytes=crypto.getRandomValues(new Uint8Array(16));
      var id=Array.from(bytes,function(byte){return byte.toString(16).padStart(2,"0");}).join("");
      previous={fingerprint:fingerprint,id:id};
      commentAttempts.set(key,previous);
    }
    return previous.id;
  };
  var doSend=function(name){
    var ready=drafts.filter(function(d){return d.text.trim();});
    if(!ready.length)return;
    var na=ready.filter(toAgent).length;
    var b=document.getElementById("__cc_sendbtn");
    var errBox=cpanel.querySelector(".__cc_cerr");
    if(b){b.disabled=true;b.textContent=na?"Sending…":"Posting…";}
    sSet("__cc_name",name||"");
    var payload={slug:CC.slug,author_name:me?me.name:((name||"").trim()||"anonymous"),
      author_email:gateEmail||undefined,version:CC.version,
      k:gateK||undefined,e:gateE||undefined,m:gateM||undefined,
      deliver:false,
      owner_key:ownerKey||undefined,
      identity_token:idTok||undefined,
      comments:ready.map(function(d){var c={text:d.text.trim(),deliver:toAgent(d)};if(d.anchor)c.anchor=JSON.stringify(d.anchor);return c;})};
    payload.client_id=commentAttempt("batch",payload);
    api("/cli/artifacts/comment",payload)
    .then(function(r){
      if(!r||r.error){if(errBox)errBox.textContent=(r&&r.error)||"Send failed — try again";syncSend();return;}
      commentAttempts.delete("batch");drafts=[];renderPins();
      cpanel.innerHTML="";
      var ok=el("div","__cc_okwrap");
      ok.appendChild(el("div","__cc_okmark","✓"));
      ok.appendChild(el("div","__cc_okt",(na?"Sent ":"Posted ")+ready.length+(ready.length===1?" comment":" comments")));
      ok.appendChild(el("div","__cc_oks",na
        ?(r.delivered?"The agent has it. This page reloads when it publishes a new version."
          :"Posted, but the agent's session could not be reached. "+(ownerKey?"Use \\u201CSend all\\u201D later.":"The owner can send it later."))
        :"Now part of this page's discussion."));
      cpanel.appendChild(ok);
      if(na&&r.delivered){awaitAgent();}
      refreshSaved(function(){setTimeout(function(){if(!cpanel.hidden)renderC();},1600);});
    },function(){if(errBox)errBox.textContent="Network error — your drafts are kept";syncSend();});
  };
`;
