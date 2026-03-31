// ─── Rumba Multiplayer Server ────────────────────────────────────────────────
// Node.js + Socket.io real-time game server
// Elke speler verbindt met zijn eigen telefoon en ziet alleen zijn eigen kaarten

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.get("/", (req, res) => res.send("Rumba server draait ✅"));

// ─── Spellogica (gedeeld met client) ─────────────────────────────────────────
const SUITS  = ["K","H","R","S"];
const VALUES = ["2","3","4","5","6","7","8","9","10","V","D","Ri","1"];
const RANK   = {"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"V":11,"D":12,"Ri":13,"1":14};

function createDeck(){
  const d=[];
  for(const s of SUITS) for(const v of VALUES) d.push({s,v,id:`${v}${s}`});
  return shuffle(d);
}
function shuffle(a){
  const b=[...a];
  for(let i=b.length-1;i>0;i--){const j=0|Math.random()*(i+1);[b[i],b[j]]=[b[j],b[i]];}
  return b;
}
function getBest(trick,trump){
  let best=trick[0]; const lead=trick[0].card.s;
  for(let i=1;i<trick.length;i++){
    const c=trick[i].card,b=best.card;
    if(c.s===trump&&b.s!==trump){best=trick[i];continue;}
    if(b.s===trump&&c.s!==trump) continue;
    if(c.s!==lead&&c.s!==trump) continue;
    if(RANK[c.v]>RANK[b.v]) best=trick[i];
  }
  return best;
}
function trickWinner(trick,trump){ return getBest(trick,trump).pi; }

function canPlay(hand,card,trick,trump){
  if(!trick.length) return true;
  const lead=trick[0].card.s;
  const hasSuit=hand.some(c=>c.s===lead);
  if(hasSuit){
    if(card.s!==lead) return false;
    const bestOfLead=trick.filter(t=>t.card.s===lead)
      .reduce((hi,t)=>RANK[t.card.v]>RANK[hi.v]?t.card:hi,trick[0].card);
    const canHi=hand.some(c=>c.s===lead&&RANK[c.v]>RANK[bestOfLead.v]);
    if(canHi&&RANK[card.v]<=RANK[bestOfLead.v]) return false;
    return true;
  }
  const hasTrump=hand.some(c=>c.s===trump);
  if(hasTrump){
    if(card.s!==trump) return false;
    const trumpsInTrick=trick.filter(t=>t.card.s===trump);
    if(trumpsInTrick.length>0){
      const highestTrump=trumpsInTrick.reduce(
        (hi,t)=>RANK[t.card.v]>RANK[hi.v]?t.card:hi,trumpsInTrick[0].card);
      const canHiT=hand.some(c=>c.s===trump&&RANK[c.v]>RANK[highestTrump.v]);
      if(canHiT&&RANK[card.v]<=RANK[highestTrump.v]) return false;
    }
    return true;
  }
  return true;
}

// ─── Spelkamers ──────────────────────────────────────────────────────────────
// rooms[code] = { players, gameState, ... }
const rooms = {};

function generateCode(){
  let code;
  do { code = Math.floor(1000+Math.random()*9000).toString(); }
  while(rooms[code]);
  return code;
}

// Stuur aan elke speler alleen zijn eigen kaarten
function broadcastGameState(room){
  const r = rooms[room];
  if(!r) return;
  r.players.forEach(p => {
    if(!p.socketId) return; // speler offline, sla over
    const socket = io.sockets.sockets.get(p.socketId);
    if(!socket) return;
    const state = buildStateForPlayer(r, p.playerIndex);
    socket.emit("gameState", state);
  });
}

function buildStateForPlayer(r, myIndex){
  const g = r.gameState;
  return {
    // Spelerinfo
    myIndex,
    myHand: g.hands ? g.hands[myIndex] : [],
    players: g.players,
    dealerIndex: g.dealerIndex,
    round: g.round,
    // Troef
    trumpCard: g.trumpCard,
    trumpSuit: g.trumpSuit,
    // Fase
    phase: g.phase,
    // Bieden
    bids: g.bids,
    bidder: g.bidder,
    // Rumba
    active: g.active,
    rumbaQ: g.rumbaQ,
    rumbaWho: g.rumbaWho,
    // Wissel
    exchQueue: g.exchQueue,
    exchIndex: g.exchIndex,
    twoOff: g.twoOff,
    twoSwapped: g.twoSwapped,
    normalExchDone: g.normalExchDone,
    newCards: g.newCards && g.newCards.forPlayer === myIndex ? g.newCards.cards : [],
    showNewCards: g.showNewCards && g.showNewCards.forPlayer === myIndex ? g.showNewCards.show : false,
    // Spelen
    trick: g.trick,
    curPlayer: g.curPlayer,
    tricksWon: g.tricksWon,
    trickCount: g.trickCount,
    // Score
    scores: g.scores,
    scoreHistory: g.scoreHistory,
    consecPasses: g.consecPasses,
    // Log
    log: g.log ? g.log.slice(0,20) : [],
    // Boer van troef melding
    boerAnnounced: g.boerAnnounced,
  };
}

function addLog(g, msg){
  if(!g.log) g.log=[];
  g.log.unshift(msg);
  if(g.log.length>50) g.log.pop();
}

// ─── Nieuwe ronde starten ────────────────────────────────────────────────────
function startNewRound(g){
  const deck = createDeck();
  const n = g.players.length;
  const hands = g.players.map((_,i) => deck.slice(i*5, i*5+5));
  const rest = deck.slice(n*5);
  g.trumpCard = rest[0];
  g.trumpSuit = rest[0].s;
  g.stockPile = rest.slice(1);
  g.hands = hands;
  g.trick = [];
  g.tricksWon = g.players.map(()=>0);
  g.trickCount = 0;
  g.scores = null;
  g.newCards = null;
  g.showNewCards = null;
  g.twoOff = false;
  g.twoSwapped = false;
  g.normalExchDone = false;
  g.rumbaWho = -1;
  g.active = [];
  g.rumbaQ = 0;
  g.exchQueue = [];
  g.exchIndex = 0;
  g.boerAnnounced = false;
  addLog(g,`── Ronde ${g.round} · Deler: ${g.players[g.dealerIndex].name}`);

  if(g.trumpCard.v === "V"){
    addLog(g,"Boer van troef! Iedereen speelt mee — direct spelen.");
    g.bids = g.players.map(()=>"in");
    g.active = g.players.map((_,i)=>i);
    g.rumbaWho = -1;
    g.consecPasses = new Array(n).fill(0);
    const fp = (g.dealerIndex+1)%n;
    g.curPlayer = fp;
    g.phase = "BOER";
    g.boerAnnounced = false;
  } else {
    g.bids = new Array(n).fill(undefined);
    g.bidder = (g.dealerIndex+1)%n;
    g.phase = "BID";
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
function resolveRound(g){
  const rWho = g.rumbaWho;
  const ft = g.tricksWon;
  const sc = g.players.map((p,i)=>{
    const isIn = g.bids[i]==="in";
    const isRumba = rWho===i;
    const passed = !isIn&&!isRumba;
    if(passed) return{name:p.name,delta:0,tricks:ft[i],passed:true};
    if(isRumba){
      const t=ft[i];
      return{name:p.name,delta:t<3?+10:-(t*2),tricks:t,passed:false,rumba:true};
    }
    const mult=rWho>=0?2:1;
    const t=ft[i];
    return{name:p.name,delta:t===0?5*mult:-(t*mult),tricks:t,passed:false};
  });
  const np = g.players.map((p,i)=>({...p,score:p.score+sc[i].delta}));
  g.scores = sc;
  if(!g.scoreHistory) g.scoreHistory=[];
  g.scoreHistory.push(np.map((p,i)=>({
    score:p.score, delta:sc[i].delta, passed:sc[i].passed, rumba:!!sc[i].rumba
  })));
  g.players = np;
  g.dealerIndex = (g.dealerIndex+1)%g.players.length;
  g.round++;
  g.phase = np.some(p=>p.score<=0) ? "END_G" : "END_R";
}

// ─── Wisselwachtrij opbouwen ──────────────────────────────────────────────────
function buildExchQueue(g){
  const n = g.players.length;
  const act = g.bids.map((b,i)=>b==="in"?i:-1).filter(i=>i>=0);
  const q = [];
  for(let i=1;i<=n;i++){
    const pi=(g.dealerIndex+i)%n;
    if(act.includes(pi)) q.push(pi);
  }
  g.exchQueue = q;
  g.exchIndex = 0;
  g.twoSwapped = false;
  g.normalExchDone = false;
  g.twoOff = g.trumpCard.v!=="V" && g.hands[q[0]].some(c=>c.v==="2"&&c.s===g.trumpSuit);
  g.phase = "EXCH";
}

function firstActivePlayer(g){
  const act = g.bids.map((b,i)=>(b==="in"||i===g.rumbaWho)?i:-1).filter(i=>i>=0);
  let fp = (g.dealerIndex+1)%g.players.length;
  while(!act.includes(fp)) fp=(fp+1)%g.players.length;
  return fp;
}

function isForced(g, playerIndex){
  if(g.players[playerIndex].score<=3) return true;
  if(g.consecPasses[playerIndex]>=2) return true;
  const inNow=g.bids.filter(b=>b==="in").length;
  const openExcl=g.bids.filter((b,bi)=>b===undefined&&bi!==playerIndex).length;
  if(inNow+openExcl<2) return true;
  return false;
}

// ─── Socket.io events ────────────────────────────────────────────────────────
io.on("connection", socket => {
  console.log("Verbonden:", socket.id);

  // ── Kamer aanmaken ──
  socket.on("createRoom", ({name}, cb) => {
    const code = generateCode();
    rooms[code] = {
      code,
      players: [{name, socketId: socket.id, playerIndex: 0}],
      gameState: {
        phase: "LOBBY",
        players: [{name, score:21}],
        dealerIndex: 0,
        round: 1,
        consecPasses: [0],
        scoreHistory: [],
        log: [],
      }
    };
    socket.join(code);
    socket.data.room = code;
    socket.data.playerIndex = 0;
    console.log(`Kamer ${code} aangemaakt door ${name}`);
    cb({code, playerIndex:0});
  });

  // ── Kamer vervoegen of herverbinden ──
  socket.on("joinRoom", ({code, name}, cb) => {
    const room = rooms[code];
    if(!room){ cb({error:"Kamer niet gevonden"}); return; }
    if(room.players.length>=6 && room.gameState.phase==="LOBBY"){ cb({error:"Kamer vol (max 6)"}); return; }

    // Controleer of dit een herverbinding is (zelfde naam, spel al bezig)
    const existingIdx = room.gameState.players.findIndex(p=>p.name===name);
    if(existingIdx>=0 && room.gameState.phase!=="LOBBY"){
      // Herverbinding — update socketId
      room.players[existingIdx].socketId = socket.id;
      socket.join(code);
      socket.data.room = code;
      socket.data.playerIndex = existingIdx;
      console.log(`${name} herverbonden met kamer ${code} als speler ${existingIdx}`);
      // Stuur meteen de huidige spelstatus
      const state = buildStateForPlayer(room, existingIdx);
      socket.emit("gameState", state);
      cb({playerIndex: existingIdx, reconnected: true});
      return;
    }

    // Nieuwe speler
    if(room.gameState.phase !== "LOBBY"){ cb({error:"Spel al bezig — gebruik je naam om te herverbinden"}); return; }

    const playerIndex = room.players.length;
    room.players.push({name, socketId:socket.id, playerIndex});
    room.gameState.players.push({name, score:21});
    room.gameState.consecPasses.push(0);

    socket.join(code);
    socket.data.room = code;
    socket.data.playerIndex = playerIndex;

    io.to(code).emit("playerJoined", {
      players: room.gameState.players,
      playerIndex
    });
    cb({playerIndex});
  });

  // ── Draw update doorsturen naar ALLE spelers (inclusief host zelf) ──
  socket.on("drawUpdate", (data) => {
    const code = socket.data.room;
    if(!code) return;
    // Sla draw state op in kamer zodat herverbinders het ook zien
    if(rooms[code]) rooms[code].drawState = data;
    // Broadcast naar iedereen in de kamer (inclusief de host zelf)
    io.to(code).emit("drawUpdate", data);
  });

  // ── Spel starten (alleen host) ──
  socket.on("startGame", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room || socket.data.playerIndex !== 0) return;
    if(room.players.length < 2){ 
      socket.emit("error", "Minimum 2 spelers nodig"); 
      return; 
    }
    const g = room.gameState;
    g.round = 1;
    startNewRound(g);
    broadcastGameState(code);
  });

  // ── Boer van troef bevestigd ──
  socket.on("boerConfirmed", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    if(g.phase !== "BOER") return;
    g.phase = "PLAY";
    broadcastGameState(code);
  });

  // ── Bieden ──
  socket.on("bid", ({bid}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    if(g.phase !== "BID") return;
    if(socket.data.playerIndex !== g.bidder) return;

    const n = g.players.length;
    const nb = [...g.bids]; nb[g.bidder] = bid;
    g.bids = nb;
    const cp = [...g.consecPasses];
    if(bid==="out") cp[g.bidder]++;
    else cp[g.bidder]=0;
    g.consecPasses = cp;
    addLog(g, `${g.players[g.bidder].name}: ${bid==="in"?"✅ mee":"❌ past"}`);

    const start = (g.dealerIndex+1)%n;
    const next = (g.bidder+1)%n;
    const inNow = nb.filter(b=>b==="in").length;
    const stillOpen = nb.filter(b=>b===undefined).length;

    // Forceer resterende spelers als min-2 bereikt wordt
    if(inNow+stillOpen<=1 && stillOpen>0){
      const forced=[...nb];
      const cp2=[...cp];
      for(let i=0;i<n;i++){
        if(forced[i]===undefined){
          forced[i]="in"; cp2[i]=0;
          addLog(g,`${g.players[i].name}: verplicht mee.`);
        }
      }
      g.bids=forced; g.consecPasses=cp2;
      g.active=forced.map((b,i)=>b==="in"?i:-1).filter(i=>i>=0);
      g.rumbaQ=0; g.phase="RUMBA";
      broadcastGameState(code); return;
    }

    if(next===start){
      const act=nb.map((b,i)=>b==="in"?i:-1).filter(i=>i>=0);
      g.active=act;
      if(act.length===0){
        addLog(g,"Niemand speelt.");
        resolveRound(g);
      } else if(act.length===1){
        const wi=act[0];
        addLog(g,`Alleen ${g.players[wi].name} speelt → -5.`);
        const sc=g.players.map((p,i)=>({name:p.name,delta:i===wi?-5:0,tricks:0,passed:i!==wi}));
        g.scores=sc;
        if(!g.scoreHistory) g.scoreHistory=[];
        g.scoreHistory.push(g.players.map((p,i)=>({score:p.score+(i===wi?-5:0),delta:sc[i].delta,passed:sc[i].passed})));
        g.players=g.players.map((p,i)=>({...p,score:p.score+(i===wi?-5:0)}));
        g.dealerIndex=(g.dealerIndex+1)%n; g.round++;
        g.phase="END_R";
      } else {
        g.rumbaQ=0; g.phase="RUMBA";
      }
    } else {
      g.bidder = next;
    }
    broadcastGameState(code);
  });

  // ── Rumba ──
  socket.on("rumba", ({call}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    if(g.phase !== "RUMBA") return;

    // Bepaal volgorde actieve spelers
    const n=g.players.length;
    const ord=[];
    const s=(g.dealerIndex+1)%n;
    for(let i=0;i<n;i++){
      const pi=(s+i)%n;
      if(g.active.includes(pi)) ord.push(pi);
    }
    const pi = ord[g.rumbaQ];
    if(socket.data.playerIndex !== pi) return;

    if(call){
      g.rumbaWho = pi;
      addLog(g,`🎺 ${g.players[pi].name} roept RUMBA!`);
      g.curPlayer = pi;
      g.phase = "PLAY";
    } else {
      addLog(g,`${g.players[pi].name}: geen rumba`);
      const nq = g.rumbaQ+1;
      if(nq>=ord.length){
        buildExchQueue(g);
      } else {
        g.rumbaQ=nq;
      }
    }
    broadcastGameState(code);
  });

  // ── 2 van troef wisselen ──
  socket.on("twoSwap", ({yes}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    if(g.phase !== "EXCH") return;
    const pi = g.exchQueue[g.exchIndex];
    if(socket.data.playerIndex !== pi) return;

    if(!yes){
      g.twoOff = false;
      if(g.normalExchDone) advanceExchServer(g);
    } else {
      const two = g.hands[pi].find(c=>c.v==="2"&&c.s===g.trumpSuit);
      const received = g.trumpCard;
      g.hands[pi] = [...g.hands[pi].filter(c=>c.id!==two.id), received];
      g.trumpCard = two;
      addLog(g,`${g.players[pi].name} wisselt 2 voor troefkaart.`);
      g.twoOff = false;
      g.twoSwapped = true;
      if(g.normalExchDone){
        advanceExchServer(g);
      }
    }
    broadcastGameState(code);
  });

  // ── Kaarten wisselen bevestigen ──
  socket.on("confirmExch", ({selectedIds}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    if(g.phase !== "EXCH") return;
    const pi = g.exchQueue[g.exchIndex];
    if(socket.data.playerIndex !== pi) return;

    let hand = g.hands[pi];
    let drawn = [];
    if(selectedIds && selectedIds.length>0){
      const kept = hand.filter(c=>!selectedIds.includes(c.id));
      drawn = g.stockPile.slice(0, selectedIds.length);
      g.stockPile = g.stockPile.slice(selectedIds.length);
      hand = [...kept, ...drawn];
      g.hands[pi] = hand;
      addLog(g,`${g.players[pi].name} wisselt ${selectedIds.length} kaart(en).`);
    } else {
      addLog(g,`${g.players[pi].name}: wisselt niets.`);
    }

    g.normalExchDone = true;

    // Stuur nieuwe kaarten naar deze speler
    if(drawn.length>0){
      g.newCards = {forPlayer:pi, cards:drawn};
      g.showNewCards = {forPlayer:pi, show:true};
    }

    // Check 2 van troef in nieuwe kaarten (alleen als nog niet gewisseld)
    const got2Trump = !g.twoSwapped &&
      g.trumpCard.v!=="V" &&
      drawn.some(c=>c.v==="2"&&c.s===g.trumpSuit);

    if(got2Trump && drawn.length>0){
      // Toon nieuwe kaarten eerst, daarna 2-van-troef aanbod via "newCardsSeen"
      g.twoOff = false; // wordt true na newCardsSeen
      g.pendingTwoOff = true;
    } else if(!got2Trump){
      g.pendingTwoOff = false;
    }

    broadcastGameState(code);
  });

  // ── Nieuwe kaarten gezien ("Doorgaan" gedrukt) ──
  socket.on("newCardsSeen", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    const pi = g.exchQueue[g.exchIndex];
    if(socket.data.playerIndex !== pi) return;

    g.showNewCards = null;

    if(g.pendingTwoOff){
      g.twoOff = true;
      g.pendingTwoOff = false;
      g.newCards = null;
    } else {
      g.newCards = null;
      advanceExchServer(g);
    }
    broadcastGameState(code);
  });

  function advanceExchServer(g){
    g.twoSwapped = false;
    g.normalExchDone = false;
    g.twoOff = false;
    g.newCards = null;
    const ni = g.exchIndex+1;
    if(ni >= g.exchQueue.length){
      g.curPlayer = firstActivePlayer(g);
      g.phase = "PLAY";
    } else {
      g.exchIndex = ni;
      const nextPi = g.exchQueue[ni];
      g.twoOff = g.trumpCard.v!=="V" &&
        g.hands[nextPi].some(c=>c.v==="2"&&c.s===g.trumpSuit);
    }
  }

  // ── Kaart spelen ──
  socket.on("playCard", ({cardId}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    if(g.phase !== "PLAY") return;
    const pi = socket.data.playerIndex;
    if(pi !== g.curPlayer) return;

    const card = g.hands[pi].find(c=>c.id===cardId);
    if(!card) return;

    // Valideer de kaart
    const act = g.bids.map((b,i)=>(b==="in"||i===g.rumbaWho)?i:-1).filter(i=>i>=0);
    if(!canPlay(g.hands[pi], card, g.trick, g.trumpSuit)) return;

    g.hands[pi] = g.hands[pi].filter(c=>c.id!==cardId);
    g.trick = [...g.trick, {pi, card}];
    addLog(g,`${g.players[pi].name} speelt ${card.v}${card.s}`);

    if(g.trick.length === act.length){
      // Slag afgehandeld
      const w = trickWinner(g.trick, g.trumpSuit);
      g.tricksWon[w]++;
      g.trickCount++;
      addLog(g,`→ ${g.players[w].name} wint slag ${g.trickCount}!`);

      // Broadcast de tussentijdse staat (kaarten nog zichtbaar op tafel)
      // Maar alleen als het NIET de laatste slag is — anders tonen we even slag 6/5
      if(g.trickCount < 5){
        broadcastGameState(code);
      }

      setTimeout(()=>{
        g.trick = [];
        if(g.trickCount === 5){
          resolveRound(g);
        } else {
          g.curPlayer = w;
        }
        broadcastGameState(code);
      }, 1400);
      return;
    } else {
      let nx = (pi+1)%g.players.length;
      while(!act.includes(nx)) nx=(nx+1)%g.players.length;
      g.curPlayer = nx;
    }
    broadcastGameState(code);
  });

  // ── Volgende ronde ──
  socket.on("nextRound", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    const g = room.gameState;
    if(g.phase !== "END_R") return;
    if(socket.data.playerIndex !== 0) return; // alleen host
    startNewRound(g);
    broadcastGameState(code);
  });

  // ── Nieuw spel ──
  socket.on("newGame", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if(!room) return;
    if(socket.data.playerIndex !== 0) return;
    const g = room.gameState;
    g.players = g.players.map(p=>({...p,score:21}));
    g.round = 1;
    g.dealerIndex = 0;
    g.consecPasses = new Array(g.players.length).fill(0);
    g.scoreHistory = [];
    g.log = [];
    startNewRound(g);
    broadcastGameState(code);
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const code = socket.data.room;
    if(!code || !rooms[code]) return;
    const room = rooms[code];
    const pi = socket.data.playerIndex;

    // Als het spel in de lobby is, verwijder de speler volledig
    if(room.gameState.phase === "LOBBY"){
      room.players = room.players.filter(p=>p.socketId!==socket.id);
      if(room.players.length===0){
        delete rooms[code];
        console.log(`Kamer ${code} verwijderd`);
      } else {
        io.to(code).emit("playerLeft", { playerIndex: pi, players: room.gameState.players });
      }
    } else {
      // Spel bezig — bewaar de slot maar markeer als offline
      // Zodat de speler kan herverbinden
      const p = room.players.find(p=>p.socketId===socket.id);
      if(p) p.socketId = null; // offline maar slot bewaard
      console.log(`${room.gameState.players[pi]?.name} verbroken uit kamer ${code} — slot bewaard`);
      io.to(code).emit("playerLeft", { playerIndex: pi, players: room.gameState.players });
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, ()=>console.log(`Rumba server op poort ${PORT}`));
