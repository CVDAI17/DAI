/* Bench — personal command center.
   Performance notes, since that was the brief:
   - Responses stream. Speech starts on the first finished sentence, not the last.
   - The board is sent as a cached system prefix, so repeat questions get a
     cheaper and faster first token.
   - Speech recognition uses interim results so you see words as you say them.
   - Voices are warmed on load; picking one lazily costs half a second. */ 

const KEY = "bench.state.v1";
const $ = (id) => document.getElementById(id);

let state = { items: [], metrics: [], brief: null };
let chat = [];
let busy = false;
let listening = false;
let voiceOut = true;
let handsFree = false;
let recog = null;
let voice = null;

/* ---------- storage ---------- */
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) {}
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    fail("Couldn't save. Storage may be full or blocked.");
  }
}

/* ---------- dates ---------- */
const uid = () => Math.random().toString(36).slice(2, 9);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const parseISO = (s) => {
  const p = (s || "").split("-").map(Number);
  return p[0] ? new Date(p[0], p[1] - 1, p[2]) : null;
};
const daysUntil = (iso) => {
  const t = parseISO(iso);
  return t ? Math.round((t - parseISO(todayISO())) / 86400000) : null;
};
function dayLabel(n) {
  if (n === null) return { text: "—", late: false, soon: false };
  if (n < 0) return { text: `${-n}d ago`, late: true, soon: false };
  if (n === 0) return { text: "today", late: false, soon: true };
  return { text: `${n}d`, late: false, soon: n <= 7 };
}
const spokenDate = (iso) => {
  const d = parseISO(iso);
  return d ? d.toLocaleDateString("en-US", { month: "long", day: "numeric" }) : "no date";
};

/* ---------- speech out ---------- */
function warmVoices() {
  if (!window.speechSynthesis) return;
  const pick = () => {
    const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    if (!vs.length) return;
    voice =
      vs.find((v) => /Samantha|Google US English|Microsoft Aria|Microsoft Jenny/i.test(v.name)) ||
      vs.find((v) => v.localService) ||
      vs[0];
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;
}
let pending = 0;
let onDrain = null;

function say(text) {
  if (!voiceOut || !window.speechSynthesis || !text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.04;
  pending++;
  u.onend = u.onerror = () => {
    pending = Math.max(0, pending - 1);
    if (pending === 0 && onDrain) { const c = onDrain; onDrain = null; c(); }
  };
  speechSynthesis.speak(u);
}
function hush() {
  onDrain = null;
  pending = 0;
  if (window.speechSynthesis) speechSynthesis.cancel();
}
/* Once it has finished speaking, reopen the mic so you can just keep talking. */
function afterSpeaking(fn) {
  if (pending === 0) setTimeout(fn, 250);
  else onDrain = () => setTimeout(fn, 250);
}

/* ---------- board as text for the model ---------- */
function board() {
  const open = openItems();
  const L = [`Today is ${todayISO()}.`];
  if (open.length) {
    L.push("\nOpen items — title | project | due | days from today:");
    open.forEach((i) => {
      const n = i.due ? daysUntil(i.due) : null;
      L.push(`- ${i.title} | ${i.project || "no project"} | ${i.due ? spokenDate(i.due) : "no date"} | ${n === null ? "n/a" : n}`);
    });
  } else L.push("\nNo open items.");
  const done = state.items.filter((i) => i.done);
  if (done.length) L.push(`\nFinished: ${done.map((i) => i.title).join("; ")}`);
  if (state.metrics.length) {
    L.push("\nTracked numbers:");
    state.metrics.forEach((m) => {
      const p = m.points.slice(-10).map((x) => `${x.d}=${x.v}`).join(", ");
      L.push(`- ${m.name}: ${p || "nothing logged yet"}`);
    });
  }
  return L.join("\n");
}

/* ---------- streaming ---------- */
async function stream(mode, messages, onText, onDone) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, board: board(), messages }),
  });
  if (!res.ok) {
    let msg = "Request failed.";
    try { msg = (await res.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(raw); } catch (e) { continue; }
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.text) {
        full += ev.delta.text;
        onText(full);
      }
    }
  }
  onDone(full);
  return full;
}

/* Speak each sentence the moment it completes, rather than waiting for the end. */
function speaker() {
  let spoken = 0;
  return {
    feed(full, done) {
      while (true) {
        const rest = full.slice(spoken);
        if (!rest) break;
        const m = rest.match(/[.!?](\s|$)/);
        let cut;
        if (m) cut = m.index + 1;
        else if (done) cut = rest.length;
        else break;
        const chunk = rest.slice(0, cut).trim();
        spoken += cut;
        if (chunk) say(chunk);
      }
    },
  };
}

/* ---------- ask ---------- */
async function ask(text, spoken) {
  if (!text.trim() || busy) return;
  hush();
  chat.push({ role: "user", content: text.trim() });
  chat.push({ role: "assistant", content: "" });
  busy = true;
  fail("");
  setHint(spoken ? "Answering…" : "Thinking…");
  renderChat();

  const sp = spoken ? speaker() : null;
  try {
    await stream(
      "voice",
      chat.slice(0, -1),
      (full) => {
        chat[chat.length - 1].content = full;
        renderChat();
        if (sp) sp.feed(full, false);
      },
      (full) => {
        chat[chat.length - 1].content = full;
        renderChat();
        if (sp) sp.feed(full, true);
      }
    );
  } catch (e) {
    chat.pop();
    fail(e.message);
  }
  busy = false;
  setHint("");
  render();
  if (spoken && handsFree && !listening) afterSpeaking(() => { if (handsFree && !busy) listen(); });
}

/* ---------- speech in ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen() {
  if (listening) { handsFree = false; $("handsfree").textContent = "Hands-free is off"; recog && recog.stop(); return; }
  if (!SR) { setHint("This browser can't do speech recognition. Chrome or Edge can."); return; }
  hush();
  $("heard").textContent = "";
  const r = new SR();
  r.lang = "en-US";
  r.interimResults = true;
  r.continuous = false;
  let final = "";
  r.onstart = () => { listening = true; $("mic").classList.add("live"); setHint("Listening — stop talking and it'll answer."); };
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const c = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += c; else interim += c;
    }
    $("heard").textContent = final || interim;
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed")
      setHint("The mic is blocked. Allow microphone access for this site in your browser settings.");
    else if (e.error === "no-speech") setHint("Didn't catch that. Tap and try again.");
    else setHint("Mic trouble: " + e.error);
  };
  r.onend = () => {
    listening = false;
    $("mic").classList.remove("live");
    if (final.trim()) { $("heard").textContent = final.trim(); ask(final.trim(), true); }
    else setHint(handsFree ? "Waiting for you." : "Tap and talk. It knows what's on your board.");
  };
  recog = r;
  try { r.start(); } catch (e) { setHint("Couldn't start the mic. Try again."); }
}

/* ---------- brief ---------- */
async function writeBrief() {
  if (busy) return;
  busy = true; fail("");
  $("writebrief").textContent = "Writing…";
  $("writebrief").disabled = true;
  const wrap = $("briefwrap");
  wrap.innerHTML = '<div class="brief" id="briefbody"></div>';
  try {
    await stream("brief", [], (full) => { $("briefbody").textContent = full; },
      (full) => { state.brief = { date: todayISO(), text: full }; save(); });
  } catch (e) { fail(e.message); }
  busy = false;
  $("writebrief").disabled = false;
  render();
}

/* ---------- render ---------- */
function openItems() {
  return state.items.filter((i) => !i.done).sort((a, b) => {
    if (!a.due) return 1; if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  });
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function setHint(t) { if (!listening || t) $("hint").textContent = t || "Tap and talk. It knows what's on your board."; }
function fail(m) { $("err").textContent = m || ""; }

function renderChat() {
  const c = $("chat");
  c.innerHTML = "";
  chat.forEach((m) => {
    if (!m.content) return;
    c.appendChild(el("div", "msg " + (m.role === "user" ? "you" : "it"), m.content));
  });
}

function renderBoard() {
  const open = openItems();
  const hero = $("hero");
  hero.innerHTML = "";
  open.filter((i) => i.due).slice(0, 3).forEach((i) => {
    const n = daysUntil(i.due);
    const box = el("div", "up" + (n < 0 ? " late" : ""));
    const num = el("div", "num");
    num.appendChild(document.createTextNode(n < 0 ? String(-n) : String(n)));
    num.appendChild(el("span", "unit", n < 0 ? "days late" : n === 0 ? "due today" : n === 1 ? "day" : "days"));
    box.appendChild(num);
    box.appendChild(el("div", "uptitle", i.title));
    if (i.project) box.appendChild(el("div", "upproj", i.project));
    hero.appendChild(box);
  });

  const list = $("list");
  list.innerHTML = "";
  if (!state.items.length) {
    list.appendChild(el("div", "empty", "Nothing on the board. Start with the things that have dates on them — those are what this is for."));
    return;
  }
  const groups = [
    ["Overdue", (i) => i.due && daysUntil(i.due) < 0],
    ["Next seven days", (i) => i.due && daysUntil(i.due) >= 0 && daysUntil(i.due) <= 7],
    ["Later", (i) => i.due && daysUntil(i.due) > 7],
    ["No date", (i) => !i.due],
  ];
  groups.forEach(([name, f]) => {
    const rows = open.filter(f);
    if (!rows.length) return;
    list.appendChild(el("div", "group", name));
    rows.forEach((i) => list.appendChild(itemRow(i)));
  });
  const done = state.items.filter((i) => i.done);
  if (done.length) {
    list.appendChild(el("div", "group", "Finished"));
    done.forEach((i) => list.appendChild(itemRow(i)));
  }
}
function itemRow(i) {
  const l = dayLabel(i.due ? daysUntil(i.due) : null);
  const row = el("div", "item" + (i.done ? " done" : ""));
  row.appendChild(el("span", "chip" + (i.done ? "" : l.late ? " late" : l.soon ? " soon" : ""), i.done ? "✓" : l.text));
  const main = el("div", "imain");
  main.appendChild(el("div", "itext", i.title));
  const meta = [i.project, i.due].filter(Boolean).join(" · ");
  if (meta) main.appendChild(el("div", "imeta", meta));
  row.appendChild(main);
  const t = el("button", "x", i.done ? "undo" : "done");
  t.onclick = () => { i.done = !i.done; save(); render(); };
  const d = el("button", "x", "×");
  d.onclick = () => { state.items = state.items.filter((z) => z.id !== i.id); save(); render(); };
  row.appendChild(t); row.appendChild(d);
  return row;
}

function renderMetrics() {
  const sel = $("mfor");
  const keep = sel.value;
  sel.innerHTML = "";
  state.metrics.forEach((m) => {
    const o = document.createElement("option");
    o.value = m.id; o.textContent = m.name;
    sel.appendChild(o);
  });
  if (keep) sel.value = keep;
  $("logrow").hidden = state.metrics.length === 0;

  const wrap = $("metrics");
  wrap.innerHTML = "";
  if (!state.metrics.length) {
    wrap.appendChild(el("div", "empty", "Nothing tracked yet. Anything you'd want a line for — ad spend, orders, a score, hours on something."));
    return;
  }
  state.metrics.forEach((m) => {
    const box = el("div", "metric");
    const head = el("div", "mhead");
    head.appendChild(el("div", "mname", m.name));
    const x = el("button", "x", "×");
    x.onclick = () => { state.metrics = state.metrics.filter((z) => z.id !== m.id); save(); render(); };
    head.appendChild(x);
    box.appendChild(head);

    const p = m.points;
    const last = p.length ? p[p.length - 1].v : null;
    const prev = p.length > 1 ? p[p.length - 2].v : null;
    const line = el("div");
    line.appendChild(el("span", "mval", last === null ? "—" : String(last)));
    if (last !== null && prev !== null && last !== prev) {
      const d = Math.round((last - prev) * 100) / 100;
      line.appendChild(el("span", "mdelta", (d > 0 ? "+" : "") + d + " since last"));
    }
    box.appendChild(line);
    if (p.length > 1) box.appendChild(spark(p));
    if (p.length) box.appendChild(el("div", "imeta", `${p.length} reading${p.length === 1 ? "" : "s"} · last ${p[p.length - 1].d}`));
    wrap.appendChild(box);
  });
}
function spark(points) {
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const W = 300, H = 44, pad = 3;
  const d = points.map((p, i) => {
    const x = (i / (points.length - 1)) * (W - pad * 2) + pad;
    const y = H - pad - ((p.v - min) / span) * (H - pad * 2);
    return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d); path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#2B4CD8"); path.setAttribute("stroke-width", "1.6");
  svg.appendChild(path);
  return svg;
}

function renderBrief() {
  const wrap = $("briefwrap");
  const btn = $("writebrief");
  btn.textContent = state.brief && state.brief.date === todayISO() ? "Write it again" : "Write today's brief";
  $("readbrief").hidden = !state.brief || !window.speechSynthesis;
  wrap.innerHTML = "";
  if (!state.brief) {
    wrap.appendChild(el("div", "empty", "No brief yet. It reads the board and tells you what today actually needs — so put a few things on the board first."));
    return;
  }
  if (state.brief.date !== todayISO()) wrap.appendChild(el("div", "imeta", "From " + state.brief.date));
  wrap.appendChild(el("div", "brief", state.brief.text));
}

function render() {
  const overdue = openItems().filter((i) => i.due && daysUntil(i.due) < 0).length;
  $("date").textContent =
    new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
    (overdue ? ` · ${overdue} overdue` : "");
  renderBoard(); renderMetrics(); renderBrief(); renderChat();
}

/* ---------- wiring ---------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "v-" + tab.dataset.view));
  };
});
$("mic").onclick = listen;
$("voiceout").onclick = () => {
  voiceOut = !voiceOut;
  if (!voiceOut) hush();
  $("voiceout").textContent = voiceOut ? "Answers are read aloud" : "Answers are silent";
};
$("handsfree").onclick = () => {
  handsFree = !handsFree;
  $("handsfree").textContent = handsFree ? "Hands-free is on" : "Hands-free is off";
  if (handsFree && !listening && !busy) listen();
  if (!handsFree && listening) { recog && recog.stop(); }
};
$("send").onclick = () => { const v = $("q").value; $("q").value = ""; ask(v, false); };
$("q").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };

$("add").onclick = () => {
  const t = $("t").value.trim();
  if (!t) return;
  state.items.push({ id: uid(), title: t, project: $("proj").value.trim(), due: $("due").value, done: false });
  $("t").value = ""; $("due").value = "";
  save(); render();
};
$("t").onkeydown = (e) => { if (e.key === "Enter") $("add").click(); };

$("addm").onclick = () => {
  const n = $("mname").value.trim();
  if (!n) return;
  state.metrics.push({ id: uid(), name: n, points: [] });
  $("mname").value = ""; save(); render();
};
$("mname").onkeydown = (e) => { if (e.key === "Enter") $("addm").click(); };
$("logv").onclick = () => {
  const v = parseFloat($("mval").value);
  const id = $("mfor").value;
  if (!id || isNaN(v)) return;
  const m = state.metrics.find((z) => z.id === id);
  m.points.push({ d: todayISO(), v });
  $("mval").value = ""; save(); render();
};
$("mval").onkeydown = (e) => { if (e.key === "Enter") $("logv").click(); };

$("writebrief").onclick = writeBrief;
$("readbrief").onclick = () => { hush(); if (state.brief) say(state.brief.text); };

load(); warmVoices(); render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
