// G2B_ALERT_WIDGET — 개찰알림 위젯 본체 (Scriptable 앱용)
// 로더가 실행될 때마다 이 파일을 새로 받아 씁니다. 여기만 고쳐서 올리면 모든 폰의 위젯이 바뀝니다.
// 크기: 작은·중간·큰 위젯, 잠금 화면(사각형·한 줄·원) 위젯

const APP_URL = "https://friese8807.github.io/g2b/";
const DATA_URL = "";          // JSON 주소 (Apps Script …/exec 또는 raw.githubusercontent.com/…/data.json)

// 밝은·어두운 화면 색 (앱의 색 토큰과 맞춘다)
const D = (l, d) => Color.dynamic(new Color(l), new Color(d));
const C = { bg: D("#ffffff", "#15171c"), card: D("#f4f5f7", "#20242c"), ink: D("#111318", "#eef0f4"), sub: D("#6b7079", "#9aa1ad"), accent: D("#3b6cf6", "#7aa2ff") };
// DrawContext 로 그리는 그림은 밝기 전환이 안 되므로 양쪽에서 보이는 고정색을 쓴다

const pad = n => String(n).padStart(2, "0");
const FONT = { r: "systemFont", m: "mediumSystemFont", s: "semiboldSystemFont", b: "boldSystemFont", rb: "boldRoundedSystemFont" };
function txt(st, s, size, color, w, scale) {
  const t = st.addText(String(s)); t.font = Font[FONT[w || "r"]](size); t.textColor = color;
  t.lineLimit = 1; t.minimumScaleFactor = scale || 0.65;      // 길면 줄바꿈 대신 글자를 줄인다
  return t;
}
function hstack(p) { const s = p.addStack(); s.layoutHorizontally(); s.centerAlignContent(); return s; }
function vstack(p) { const s = p.addStack(); s.layoutVertically(); return s; }

/* 데이터: 새로 받고, 실패하면 마지막으로 받은 것을 "오프라인"으로 표시 */
async function getData(opts) {
  const fm = FileManager.local(), path = fm.joinPath(fm.cacheDirectory(), "g2b-alert-widget.json");
  let d = null, stale = false;
  try {
    const r = new Request(DATA_URL + (DATA_URL.includes("?") ? "&" : "?") + "t=" + Date.now());
    r.timeoutInterval = 12;
    // Apps Script 로 보낼 때:  r.method = "POST"; r.headers = { "Content-Type": "text/plain;charset=utf-8" }; r.body = JSON.stringify({ action: "widget", who: opts.who, pin: opts.pin });
    d = await r.loadJSON();
    if (d && d.ok !== false) fm.writeString(path, JSON.stringify(d)); else d = null;
  } catch (e) { d = null; }
  if (!d && fm.fileExists(path)) { try { d = JSON.parse(fm.readString(path)); stale = true; } catch (e) {} }
  if (!d) return null;
  const now = new Date();
  d.when = (stale ? "오프라인 " : "") + pad(now.getHours()) + ":" + pad(now.getMinutes());
  return d;
}

function header(w, d) {
  const h = hstack(w); txt(h, "개찰알림", 12, C.sub, "s"); h.addSpacer(); txt(h, d.when, 10, C.sub);
  w.addSpacer(6);
}
/* ▼ 크기별 화면 — 앱 내용에 맞게 채운다. 작은 위젯은 숫자 하나, 중간은 2~3개, 큰 위젯은 목록 */
function small(w, d) { header(w, d); txt(w, d.title || "–", 13, C.sub, "m"); txt(w, d.value || "–", 26, C.ink, "rb", 0.5); w.addSpacer(); }
function medium(w, d) { small(w, d); }
function large(w, d) { small(w, d); }
function accessory(w, d, fam) {
  if (fam === "accessoryInline") { txt(w, (d.title || "") + " " + (d.value || ""), 12, C.ink, "s"); return; }
  txt(w, d.title || "개찰알림", 11, C.ink, "s"); txt(w, d.value || "–", 16, C.ink, "rb", 0.5);
}

module.exports = async function (opts) {
  opts = opts || {};
  const fam = config.widgetFamily || String(args.widgetParameter || opts.preview || "medium");
  const w = new ListWidget();
  w.url = APP_URL + "?via=widget";                              // 누르면 앱 열기 (접속 기록에 '위젯'으로 남는다)
  if (!fam.startsWith("accessory")) { w.backgroundColor = C.bg; w.setPadding(13, 14, 12, 14); }
  const d = await getData(opts);
  if (!d) {
    txt(w, "개찰알림", 13, C.ink, "b"); txt(w, "불러오지 못했어요", 11, C.sub);
    w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  } else {
    if (fam.startsWith("accessory")) accessory(w, d, fam);
    else if (fam === "small") small(w, d); else if (fam === "large") large(w, d); else medium(w, d);
    w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);  // 아이폰이 실제 시각은 정한다 (보통 15~30분)
  }
  if (config.runsInWidget || config.runsInAccessoryWidget) Script.setWidget(w);
  else if (fam === "small") await w.presentSmall(); else if (fam === "large") await w.presentLarge(); else await w.presentMedium();
  Script.complete();
};
