
(function(){
'use strict';
var synth = window.speechSynthesis;
var listenBtn = document.getElementById('listen');
if(!synth){ if(listenBtn) listenBtn.style.display='none'; return; }

var BLOCK_SEL='h1,h2,h3,h4,h5,h6,p,li,td,th,pre,figcaption';
var DEFAULTS={rate:1, voice:'', scroll:true, skipCode:true, skipTables:false, skipLinks:true};
var prefs=DEFAULTS;
try{ prefs=Object.assign({},DEFAULTS,JSON.parse(localStorage.getItem('tts:prefs')||'{}')); }catch(e){}
function savePrefs(){ try{localStorage.setItem('tts:prefs',JSON.stringify(prefs));}catch(e){} }
var POSKEY='tts:pos:'+(window.PATH||location.search);

var S={segs:[], cur:-1, playing:false, open:false, utter:null, voices:[]};

/* ---------- text helpers ---------- */
// Same-length cleanup: URLs and emoji/pictographs become spaces so speech-boundary
// character indexes still line up with the displayed text.
function blank(m){ return Array(m.length+1).join(' '); }
function cleanSameLen(t){
  t=t.replace(/https?:\/\/[^\s)>\]]+/g, blank);
  t=t.replace(/[\u2190-\u2BFF\u2E00-\u2E4F\uFE00-\uFE0F\u200D\u20E3\u2705\u274C\u2764]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g, blank);
  return t;
}
var ABBREV=/(?:\b(?:e\.g|i\.e|etc|vs|cf|ca|approx|Dr|Mr|Ms|Mrs|Prof|St|no)\.\s+|\b[A-Z]\.\s+)$/;
function splitLong(text,a,b,out){
  while(b-a>280){
    var win=text.slice(a,a+260), cut=-1;
    var m=win.match(/^[\s\S]*[;,—:]\s/);
    if(m) cut=a+m[0].length;
    if(cut<=a){ var sp=win.lastIndexOf(' '); cut=sp>40? a+sp+1 : a+260; }
    out.push([a,cut]); a=cut;
  }
  out.push([a,b]);
}
function splitSentences(text){
  var out=[], re=/[.!?…]+["')\]”’]*\s+/g, last=0, m;
  while((m=re.exec(text))){
    var end=m.index+m[0].length;
    if(ABBREV.test(text.slice(last,end))) continue;
    splitLong(text,last,end,out); last=end;
  }
  if(last<text.length) splitLong(text,last,text.length,out);
  return out;
}
function splitLines(text){
  var out=[], last=0;
  for(var i=0;i<text.length;i++) if(text[i]==='\n'){ out.push([last,i+1]); last=i+1; }
  if(last<text.length) out.push([last,text.length]);
  return out;
}

/* ---------- segmentation: wrap sentences in spans without breaking formatting ---------- */
function segment(){
  var c=document.getElementById('c');
  S.segs=[]; S.cur=-1;
  var blocks=c.querySelectorAll(BLOCK_SEL);
  var all=[];
  blocks.forEach(function(block){
    var nodes=[], w=document.createTreeWalker(block,NodeFilter.SHOW_TEXT,null), n;
    while((n=w.nextNode())){
      var pe=n.parentElement, pb=pe && pe.closest(BLOCK_SEL);
      if(pb===block) nodes.push(n);
    }
    if(!nodes.length) return;
    var text=nodes.map(function(x){return x.nodeValue;}).join('');
    if(!text.trim()) return;
    var tag=block.tagName;
    var type = tag==='PRE'?'code' : (tag==='TD'||tag==='TH')?'table' : /^H\d$/.test(tag)?'head':'text';
    var ranges = type==='code'? splitLines(text) : splitSentences(text);
    var local=ranges.map(function(r){ return {start:r[0],end:r[1],spans:[],text:text.slice(r[0],r[1])}; });
    var pos=0;
    nodes.forEach(function(node){
      var len=node.nodeValue.length, nS=pos, nE=pos+len; pos=nE;
      if(!len) return;
      var frag=document.createDocumentFragment(), made=false;
      local.forEach(function(sg){
        var s=Math.max(sg.start,nS), e=Math.min(sg.end,nE);
        if(s>=e) return;
        var sp=document.createElement('span'); sp.className='tts-seg';
        sp.textContent=node.nodeValue.slice(s-nS,e-nS);
        sg.spans.push({el:sp, from:s-sg.start, to:e-sg.start});
        frag.appendChild(sp); made=true;
      });
      if(made) node.parentNode.replaceChild(frag,node);
    });
    local.forEach(function(sg){
      if(!sg.spans.length) return;
      var speak=cleanSameLen(sg.text);
      var linkCh=0,total=0;
      sg.spans.forEach(function(s){ var l=s.el.textContent.length; total+=l; if(s.el.closest('a')) linkCh+=l; });
      all.push({type:type, linky: total>0 && linkCh/total>0.8, spans:sg.spans,
                disp:sg.text, speak:speak, words:(speak.match(/\S+/g)||[]).length});
    });
  });
  all.forEach(function(sg){
    if(sg.speak.trim()){ sg.spans.forEach(function(s){ s.el.dataset.si=S.segs.length; }); S.segs.push(sg); }
  });
}
function stale(){ return !S.segs.length || !S.segs[0].spans[0].el.isConnected; }
function skippable(sg){
  return (prefs.skipCode && sg.type==='code') || (prefs.skipTables && sg.type==='table')
      || (prefs.skipLinks && sg.linky);
}
function nextPlayable(i){ while(i<S.segs.length && skippable(S.segs[i])) i++; return i<S.segs.length? i : null; }
function prevPlayable(i){ while(i>=0 && skippable(S.segs[i])) i--; return i>=0? i : null; }

/* ---------- highlighting ---------- */
function clearWord(){ if(window.Highlight && CSS.highlights) CSS.highlights.delete('tts-word'); }
function highlight(i){
  document.querySelectorAll('.tts-cur').forEach(function(e){ e.classList.remove('tts-cur'); });
  clearWord();
  if(i<0 || !S.segs[i]) return;
  S.segs[i].spans.forEach(function(s){ s.el.classList.add('tts-cur'); });
  if(prefs.scroll){
    var el=S.segs[i].spans[0].el, r=el.getBoundingClientRect(), h=window.innerHeight;
    if(r.top<h*0.18 || r.bottom>h*0.72) el.scrollIntoView({block:'center',behavior:'smooth'});
  }
}
function wordHi(i,ci,cl){
  if(!(window.Highlight && CSS.highlights)) return;
  var sg=S.segs[i]; if(!sg) return;
  var end;
  if(cl) end=ci+cl;
  else { var m=sg.disp.slice(ci).match(/^\S+/); end=ci+(m? m[0].length : 1); }
  var range=null;
  for(var k=0;k<sg.spans.length;k++){
    var s=sg.spans[k];
    if(ci<s.to && end>s.from){
      var node=s.el.firstChild; if(!node) continue;
      var a=Math.max(ci,s.from)-s.from, b=Math.min(end,s.to)-s.from;
      if(!range){ range=new Range(); range.setStart(node,a); }
      range.setEnd(node,b);
    }
  }
  if(range) CSS.highlights.set('tts-word', new Highlight(range));
}

/* ---------- voices ---------- */
function loadVoices(){
  S.voices=synth.getVoices()||[];
  var sel=document.getElementById('tts-voice'); if(!sel) return;
  var en=S.voices.filter(function(v){return /^en/i.test(v.lang);});
  var rest=S.voices.filter(function(v){return !/^en/i.test(v.lang);});
  sel.innerHTML='';
  function opt(v){ var o=document.createElement('option'); o.value=v.voiceURI;
    o.textContent=v.name+' ('+v.lang+')'; return o; }
  var g1=document.createElement('optgroup'); g1.label='English';
  en.forEach(function(v){ g1.appendChild(opt(v)); });
  sel.appendChild(g1);
  if(rest.length){ var g2=document.createElement('optgroup'); g2.label='Other';
    rest.forEach(function(v){ g2.appendChild(opt(v)); }); sel.appendChild(g2); }
  var cur=findVoice(); if(cur) sel.value=cur.voiceURI;
}
function findVoice(){
  if(!S.voices.length) S.voices=synth.getVoices()||[];
  var v=S.voices.filter(function(x){return x.voiceURI===prefs.voice;})[0];
  if(v) return v;
  var en=S.voices.filter(function(x){return /^en/i.test(x.lang);});
  var pref=/Samantha|Ava|Zoe|Allison|Karen|Daniel|Serena|Google US English|Google UK English/i;
  return en.filter(function(x){return pref.test(x.name);})[0] || en[0] || S.voices[0] || null;
}

/* ---------- playback ---------- */
function speakFrom(i){
  var idx=nextPlayable(i);
  if(idx===null){ finish(); return; }
  S.cur=idx; highlight(idx); savePos(); updateBar();
  var sg=S.segs[idx];
  var u=new SpeechSynthesisUtterance(sg.speak);
  u.rate=prefs.rate;
  var v=findVoice(); if(v){ u.voice=v; u.lang=v.lang; }
  u.onend=function(){ if(S.utter!==u || !S.playing) return; speakFrom(idx+1); };
  u.onerror=function(e){
    if(S.utter!==u) return;
    if(e.error==='interrupted'||e.error==='canceled') return;
    if(S.playing) speakFrom(idx+1);
  };
  u.onboundary=function(e){ if(e.name==='word' && S.utter===u) wordHi(idx,e.charIndex,e.charLength); };
  S.utter=u;
  synth.cancel();
  setTimeout(function(){ if(S.utter===u && S.playing) synth.speak(u); },60);
}
function play(){
  if(stale()) segment();
  if(!S.segs.length){ toastSafe('Nothing readable on this page'); return; }
  S.playing=true;
  if(S.cur<0) S.cur=nextPlayable(0)||0;
  speakFrom(S.cur); updateBar();
}
function pause(){ S.playing=false; S.utter=null; synth.cancel(); clearWord(); updateBar(); }
function togglePlay(){ S.playing? pause() : play(); }
function finish(){
  S.playing=false; S.utter=null; synth.cancel();
  highlight(-1); S.cur=-1; clearPos(); updateBar();
  toastSafe('Finished ✓');
}
function step(dir){
  var j = dir>0? nextPlayable(S.cur+1) : prevPlayable(S.cur-1);
  if(j===null) return;
  if(S.playing) speakFrom(j);
  else { S.cur=j; highlight(j); savePos(); updateBar(); }
}
function jumpTo(i){ S.playing=true; speakFrom(i); }
function restart(){ clearPos(); S.playing=true; speakFrom(0); }

/* position memory */
function savePos(){ try{localStorage.setItem(POSKEY,JSON.stringify({i:S.cur,n:S.segs.length}));}catch(e){} }
function clearPos(){ try{localStorage.removeItem(POSKEY);}catch(e){} }
function loadPos(){
  try{ var p=JSON.parse(localStorage.getItem(POSKEY)||'null');
    if(p && p.n===S.segs.length && p.i>2 && p.i<S.segs.length) return p.i;
  }catch(e){}
  return null;
}

/* Chrome stalls speech >~15s; a pause/resume tick keeps it flowing on long sentences. */
if(window.chrome){
  setInterval(function(){
    if(S.playing && synth.speaking && !synth.paused){ synth.pause(); synth.resume(); }
  }, 9000);
}

/* ---------- UI ---------- */
function el(id){ return document.getElementById(id); }
function toastSafe(m){ if(window.toast) toast(m); }
function fmtLeft(){
  var words=0;
  for(var k=Math.max(S.cur,0); k<S.segs.length; k++) if(!skippable(S.segs[k])) words+=S.segs[k].words;
  var min=words/(185*prefs.rate);
  return min<1? '<1 min left' : Math.round(min)+' min left';
}
function counts(){
  var total=0, done=0;
  for(var k=0;k<S.segs.length;k++){
    if(skippable(S.segs[k])) continue;
    total++; if(k<S.cur) done++;
  }
  return [done,total];
}
function updateBar(){
  if(!S.open) return;
  el('tts-play').textContent = S.playing? '⏸' : '▶';
  var c=counts();
  el('tts-fill').style.width=(c[1]? Math.round(100*c[0]/c[1]) : 0)+'%';
  el('tts-info').textContent = c[0]+' / '+c[1]+' · '+fmtLeft();
}
function buildBar(){
  if(el('ttsbar')) return;
  var bar=document.createElement('div'); bar.id='ttsbar';
  bar.innerHTML=
   '<button class="tbtn" id="tts-restart" title="Restart from the top">⟲</button>'
  +'<button class="tbtn" id="tts-prev" title="Previous sentence (←)">⏮</button>'
  +'<button class="tbtn big" id="tts-play" title="Play / pause (space)">▶</button>'
  +'<button class="tbtn" id="tts-next" title="Next sentence (→)">⏭</button>'
  +'<div class="tprog" id="tts-track" title="Jump"><div class="tfill" id="tts-fill"></div></div>'
  +'<div class="tinfo" id="tts-info">–</div>'
  +'<select class="tsel" id="tts-rate" title="Speed"></select>'
  +'<select class="tsel" id="tts-voice" title="Voice"></select>'
  +'<button class="tbtn" id="tts-cog" title="Options">⚙</button>'
  +'<button class="tbtn" id="tts-close" title="Close reader">✕</button>';
  document.body.appendChild(bar);
  var panel=document.createElement('div'); panel.id='ttspanel';
  panel.innerHTML='<div class="ph">Reading options</div>'
   +'<label><input type="checkbox" id="tts-oscroll"> Auto-scroll to the current sentence</label>'
   +'<label><input type="checkbox" id="tts-ocode"> Skip code blocks</label>'
   +'<label><input type="checkbox" id="tts-otable"> Skip tables</label>'
   +'<label><input type="checkbox" id="tts-olinks"> Skip link-only lines (nav lists)</label>';
  document.body.appendChild(panel);

  [0.7,0.85,1,1.15,1.3,1.5,1.75,2].forEach(function(r){
    var o=document.createElement('option'); o.value=r; o.textContent=r+'×';
    el('tts-rate').appendChild(o);
  });
  el('tts-rate').value=prefs.rate;
  loadVoices();
  if(synth.onvoiceschanged!==undefined) synth.addEventListener('voiceschanged',loadVoices);

  el('tts-play').onclick=togglePlay;
  el('tts-prev').onclick=function(){ step(-1); };
  el('tts-next').onclick=function(){ step(1); };
  el('tts-restart').onclick=restart;
  el('tts-close').onclick=closePlayer;
  el('tts-rate').onchange=function(){ prefs.rate=parseFloat(this.value); savePrefs();
    if(S.playing) speakFrom(S.cur); else updateBar(); };
  el('tts-voice').onchange=function(){ prefs.voice=this.value; savePrefs();
    if(S.playing) speakFrom(S.cur); };
  el('tts-cog').onclick=function(){ syncPanel(); panel.classList.toggle('on'); };
  el('tts-track').onclick=function(e){
    var r=this.getBoundingClientRect(), f=Math.min(Math.max((e.clientX-r.left)/r.width,0),1);
    var c=counts(), target=Math.floor(f*c[1]), seen=0;
    for(var k=0;k<S.segs.length;k++){
      if(skippable(S.segs[k])) continue;
      if(seen>=target){ jumpTo(k); return; }
      seen++;
    }
  };
  function bindOpt(id,key){
    el(id).onchange=function(){ prefs[key]=this.checked; savePrefs(); updateBar();
      if(S.cur>=0 && skippable(S.segs[S.cur]) && S.playing) speakFrom(S.cur); };
  }
  bindOpt('tts-oscroll','scroll'); bindOpt('tts-ocode','skipCode');
  bindOpt('tts-otable','skipTables'); bindOpt('tts-olinks','skipLinks');
  function syncPanel(){
    el('tts-oscroll').checked=prefs.scroll; el('tts-ocode').checked=prefs.skipCode;
    el('tts-otable').checked=prefs.skipTables; el('tts-olinks').checked=prefs.skipLinks;
  }
}
function openPlayer(){
  if(S.open) return;
  buildBar();
  if(stale()) segment();
  S.open=true;
  document.body.classList.add('tts-on');
  document.getElementById('c').classList.add('tts-active');
  el('ttsbar').classList.add('on');
  var saved=loadPos();
  if(saved!==null && S.cur<0){ S.cur=saved; highlight(saved);
    toastSafe('Resuming where you left off — ⟲ restarts'); }
  updateBar();
}
function closePlayer(){
  pause();
  S.open=false;
  document.body.classList.remove('tts-on');
  document.getElementById('c').classList.remove('tts-active');
  el('ttsbar').classList.remove('on');
  el('ttspanel').classList.remove('on');
  highlight(-1);
}

/* click a sentence to play from there */
document.addEventListener('click',function(e){
  if(!S.open) return;
  if(e.target.closest('a')) return;
  var sp=e.target.closest('.tts-seg');
  if(sp && sp.dataset.si!==undefined && sp.dataset.si!==''){
    jumpTo(parseInt(sp.dataset.si,10));
  }
});

/* keyboard */
document.addEventListener('keydown',function(e){
  if(!S.open) return;
  var t=e.target;
  if(t && (t.tagName==='TEXTAREA'||t.tagName==='INPUT'||t.tagName==='SELECT'||t.isContentEditable)) return;
  if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
  else if(e.key==='ArrowRight'){ e.preventDefault(); step(1); }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); step(-1); }
  else if(e.key==='Escape'){ closePlayer(); }
});

/* stop when entering edit mode; content re-renders on save so spans go stale (re-segmented on reopen) */
if(window.toEdit){
  var _edit=window.toEdit;
  window.toEdit=function(){ if(S.open) closePlayer(); _edit(); };
}
window.addEventListener('beforeunload',function(){ synth.cancel(); });

window.TTS={ toggle:function(){ S.open? closePlayer() : openPlayer(); } };

/* deep-link autostart (?listen=1): wait for markdown render, open, try to play */
if(window.AUTOLISTEN){
  var tries=0, t=setInterval(function(){
    var c=document.getElementById('c');
    tries++;
    if(c && c.children.length>0){
      clearInterval(t); openPlayer();
      play();
      setTimeout(function(){ if(S.playing && !synth.speaking && !synth.pending){
        /* browser blocked speech without a gesture: wait for the user to press play */
        S.playing=false; updateBar(); toastSafe('Press ▶ to start listening');
      } },1500);
    } else if(tries>50){ clearInterval(t); }
  },200);
}
})();
