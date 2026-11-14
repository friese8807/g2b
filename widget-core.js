// G2B_ALERT_WIDGET — 개찰알림 위젯 본체 (Scriptable 앱용)
// 로더가 실행될 때마다 이 파일을 새로 받아 씁니다. 여기만 고쳐서 올리면 모든 폰의 위젯이 바뀝니다.
// 모양: B안 큰 숫자 요약 — 새 알림·오늘 개찰·개찰 대기 + 최근 개찰결과

const APP_URL = "https://friese8807.github.io/g2b/";

// 밝은·어두운 화면 색 (앱의 파스텔 하늘 색과 맞춤)
const D = (l, d) => Color.dynamic(new Color(l), new Color(d));
const C = {
  bg: D("#ffffff", "#1c1e24"), card: D("#f4f7fa", "#262a33"), ink: D("#111318", "#eef0f4"), sub: D("#6b7079", "#9aa1ad"),
  num: D("#2b6ca3", "#9ccbf0"), mine: D("#fff4c2", "#3b3412"), mineInk: D("#6b4e00", "#ffe48a"),
  go: new Color("#2fa36b"), warn: new Color("#e3a008"), violet: new Color("#7c5cd6"),
};
const pad = n => String(n).padStart(2, "0");
function txt(st, s, size, color, w, scale) {
  const t = st.addText(String(s));
  t.font = w === "b" ? Font.boldSystemFont(size) : w === "rb" ? Font.boldRoundedSystemFont(size) : w === "s" ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = scale || 0.7;
  return t;
}
function hstack(p) { const s = p.addStack(); s.layoutHorizontally(); s.centerAlignContent(); return s; }
function vstack(p) { const s = p.addStack(); s.layoutVertically(); return s; }
const rate = v => { const n = Number(v); return n ? n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") + "%" : ""; };

/* 데이터: 새로 받고, 실패하면 마지막으로 받은 것을 "오프라인"으로 */
async function getData(o) {
  const fm = FileManager.local(), path = fm.joinPath(fm.cacheDirectory(), "g2b-alert-widget.json");
  let d = null, stale = false, err = "";
  if (!o.server) err = "로더 맨 위에 서버 주소를 넣어 주세요";
  else {
    try {
      const r = new Request(o.server);
      r.method = "POST"; r.timeoutInterval = 20;
      r.headers = { "Content-Type": "text/plain;charset=utf-8" };
      r.body = JSON.stringify({ action: "widget", token: o.token });
      const j = await r.loadJSON();
      if (j && j.ok) { d = j.data; fm.writeString(path, JSON.stringify(d)); }
      else err = (j && j.message) || "불러오지 못했어요";
    } catch (e) { err = "연결 안 됨"; }
  }
  if (!d && fm.fileExists(path)) { try { d = JSON.parse(fm.readString(path)); stale = true; } catch (e) {} }
  if (!d) return { err };
  const now = new Date();
  d.when = (stale ? "오프라인 " : "") + pad(now.getHours()) + ":" + pad(now.getMinutes());
  return d;
}

function header(w, d) {
  const h = hstack(w); txt(h, "개찰알림", 12, C.sub, "s"); h.addSpacer(); txt(h, d.when, 10, C.sub);
  w.addSpacer(6);
}
function numBox(p, n, label) {
  const b = vstack(p); b.backgroundColor = C.card; b.cornerRadius = 12; b.setPadding(7, 4, 7, 4); b.centerAlignContent();
  const t = hstack(b); t.addSpacer(); txt(t, n, 24, C.num, "rb"); t.addSpacer();
  const l = hstack(b); l.addSpacer(); txt(l, label, 10, C.sub); l.addSpacer();
}
function nums(w, d) {
  const r = hstack(w);
  numBox(r, d.unread, "새 알림"); r.addSpacer(7); numBox(r, d.today, "오늘 개찰"); r.addSpacer(7); numBox(r, d.waiting, "개찰 대기");
}
function item(w, it) {
  const r = hstack(w); r.topAlignContent();
  const dot = r.addStack(); dot.size = new Size(7, 7); dot.cornerRadius = 4;
  dot.backgroundColor = it.status === "유찰" ? C.warn : it.status === "재입찰" ? C.violet : C.go;
  r.addSpacer(6);
  const m = vstack(r);
  txt(m, it.name, 12.5, C.ink, "s", 0.8);
  txt(m, it.status + (it.top ? " · " + it.top + " " + rate(it.rate) : ""), 10, C.sub, "r", 0.8);
  r.addSpacer(4);
  if (it.mine) { const t = hstack(r); t.backgroundColor = C.mine; t.cornerRadius = 5; t.setPadding(1, 5, 1, 5); txt(t, "우리 " + it.mine + "위", 10, C.mineInk, "b"); }
}
function empty(w) { txt(w, "아직 받은 개찰결과가 없어요", 11, C.sub); }

function small(w, d) {
  header(w, d);
  txt(w, d.unread, 34, C.num, "rb");
  txt(w, "새 개찰결과", 11, C.sub);
  w.addSpacer();
  const it = d.items[0];
  if (it) {
    const t = w.addText(it.name); t.font = Font.semiboldSystemFont(11.5); t.textColor = C.ink; t.lineLimit = 2;
    if (it.mine) { w.addSpacer(2); const b = hstack(w); b.backgroundColor = C.mine; b.cornerRadius = 4; b.setPadding(1, 4, 1, 4); txt(b, "우리 " + it.mine + "위", 10, C.mineInk, "b"); }
    else txt(w, it.status, 10, C.sub);
  }
}
function medium(w, d) {
  header(w, d); nums(w, d); w.addSpacer(8);
  if (d.items[0]) item(w, d.items[0]); else empty(w);
  w.addSpacer();
}
function large(w, d) {
  header(w, d); nums(w, d); w.addSpacer(10);
  if (!d.items.length) empty(w);
  d.items.slice(0, 5).forEach((it, i) => { if (i) w.addSpacer(8); item(w, it); });
  w.addSpacer();
}
function accessory(w, d, fam) {
  if (fam === "accessoryInline") { txt(w, "개찰 새 " + d.unread + " · 대기 " + d.waiting, 12, C.ink, "s"); return; }
  if (fam === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    const a = hstack(w); a.addSpacer(); txt(a, d.unread, 22, Color.white(), "rb"); a.addSpacer();
    const b = hstack(w); b.addSpacer(); txt(b, "새 알림", 9, Color.white(), "s"); b.addSpacer(); return;
  }
  txt(w, "새 " + d.unread + " · 오늘 " + d.today + " · 대기 " + d.waiting, 13, Color.white(), "b");
  const it = d.items[0];
  if (it) txt(w, (it.mine ? "우리 " + it.mine + "위 · " : it.status + " · ") + it.name, 11, Color.white(), "r", 0.8);
}

module.exports = async function (o) {
  o = o || {};
  const fam = config.widgetFamily || String(args.widgetParameter || "medium");
  const w = new ListWidget();
  w.url = APP_URL + "?via=widget";
  if (!fam.startsWith("accessory")) { w.backgroundColor = C.bg; w.setPadding(13, 14, 12, 14); }
  const d = await getData(o);
  if (!d.items) {
    txt(w, "개찰알림", 13, C.ink, "b"); w.addSpacer(4);
    const t = w.addText(d.err || "불러오지 못했어요"); t.font = Font.systemFont(11); t.textColor = C.sub;
    w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  } else {
    if (fam.startsWith("accessory")) accessory(w, d, fam);
    else if (fam === "small") small(w, d); else if (fam === "large") large(w, d); else medium(w, d);
    w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);   // 실제 새로고침 시각은 아이폰이 정한다 (보통 15~30분)
  }
  if (config.runsInWidget || config.runsInAccessoryWidget) Script.setWidget(w);
  else if (fam === "small") await w.presentSmall(); else if (fam === "large") await w.presentLarge(); else await w.presentMedium();
  Script.complete();
};
