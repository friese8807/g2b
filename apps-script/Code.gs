/**
 * 개찰알림 서버 (Google Apps Script)
 *
 * 하는 일
 *  - 앱(github.io)의 요청 처리: 입찰공고 검색, 감시 목록, 설정(확인 간격 등), 결과 목록, 업체별 순위
 *  - 정해진 간격마다 나라장터 개찰결과를 확인해 감시 공고·키워드·기관에 맞으면
 *    결과를 저장하고 Gmail·텔레그램으로 알림 (위젯과 앱은 저장된 결과를 읽음)
 *
 * 처음 설정: README.md 의 순서대로
 *  1) 스크립트 속성 G2B_KEY = 공공데이터포털 서비스키
 *  2) 배포 → 새 배포 → 웹 앱 (실행: 나, 액세스: 모든 사용자)
 *  3) setup 실행 → 실행 기록에 나온 "앱 연결 링크"를 휴대폰에서 열기
 */

const APP_URL = 'https://friese8807.github.io/g2b/';
const TZ = 'Asia/Seoul';
const SCRS = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService/';
// 입찰공고정보서비스는 2026-11 개편으로 이름 끝에 02가 붙었다(옛 주소는 2027-02 초까지 유지). 되는 쪽을 기억해 쓴다
const BID_APIS = [
  { base: 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService02/', suffix: '02' },
  { base: 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService/', suffix: '' },
];
const P = PropertiesService.getScriptProperties();
const DEFAULTS = {
  interval: 1, startHour: 8, endHour: 20, weekends: false, kinds: ['Servc'],
  // 개찰결과 알림 대상: ★감시 공고 + 우리 회사가 참여한 개찰 + 동종업체가 참여한 개찰 (2026-11-16 사용자 지정)
  myCompanies: ['올포랜드', '엘티메트릭'],
  rivals: ['UST21', '유에스티21', '해양정보기술', '그린블루', '지오스토리', '파이텍'],
  keywords: [], institutions: [], exclude: [],
  myName: '올포랜드', myBizno: '', mail: true, email: '', telegram: true,
};
// 예전 설정(키워드 감시)에서 넘어올 때 한 번: 키워드 알림은 쓰지 않는다
const RULE_VER = '2';
const KIND_NM = { Servc: '용역', Thng: '물품', Cnstwk: '공사', Frgcpt: '외자' };

// ════════════════════════ 앱 요청 처리 ════════════════════════

function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents || '{}'); } catch (x) {}
  return out_(handle_(req));
}

/** GET: JSONP(?callback=&p=) 또는 위젯(?action=widget&token=) */
function doGet(e) {
  const q = e.parameter || {};
  if (!q.callback && !q.p && !q.action) return HtmlService.createHtmlOutput('<meta http-equiv="refresh" content="0;url=' + APP_URL + '">');
  let req = q;
  if (q.p) { try { req = JSON.parse(q.p); } catch (x) { req = {}; } }
  const res = handle_(req);
  if (q.callback && /^[\w$.]+$/.test(q.callback)) {
    return ContentService.createTextOutput(q.callback + '(' + JSON.stringify(res) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return out_(res);
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function handle_(req) {
  try {
    const tok = P.getProperty('APP_TOKEN');
    if (!tok || req.token !== tok) return { ok: false, code: 'auth', message: '연결 암호가 맞지 않아요. 설정에서 다시 연결해 주세요' };
    const a = req.action;
    if (a === 'load') return ok_(snapshot_());
    if (a === 'widget') return ok_(widget_());
    if (a === 'search') return ok_(search_(req.text || '', Number(req.days) || 30, req.kinds || settings_().kinds));
    if (a === 'watch') { addWatch_(req.item); return ok_(snapshot_()); }
    if (a === 'unwatch') { removeWatch_(req.no); return ok_(snapshot_()); }
    if (a === 'saveSettings') { saveSettings_(req.settings || {}); return ok_(snapshot_()); }
    if (a === 'read') { markRead_(req.all ? null : req.keys || []); return ok_({ done: true }); }
    if (a === 'detail') return ok_(detail_(req.key, req.no, req.ord));
    if (a === 'notice') return ok_(notice_(String(req.no || ''), req.kind));
    if (a === 'test') { const sent = testNotify(); const sn = snapshot_(); sn.sent = sent; return ok_(sn); }
    if (a === 'checkNow') { const n = check_(true); const s = snapshot_(); s.newCount = n; return ok_(s); }
    return { ok: false, code: 'bad', message: '알 수 없는 요청이에요' };
  } catch (e) {
    console.error(e);
    return { ok: false, code: 'err', message: plain_(e) };
  }
}
function ok_(data) { return { ok: true, data: data }; }

/** 서버 오류를 쉬운 말로 */
function plain_(e) {
  const m = String(e && e.message || e);
  if (/LIMITED|한도|exceeds/i.test(m)) return '오늘 공공데이터 호출 한도를 넘었어요. 내일 풀리거나 운영계정을 신청해 주세요';
  if (/SERVICE_KEY|등록되지 않은|인증/i.test(m)) return '공공데이터 인증키가 아직 등록되지 않았어요 (활용신청 승인 후 1~2시간 걸릴 수 있어요)';
  if (/G2B_KEY/.test(m)) return m;
  if (/Timeout|timed out|시간/i.test(m)) return '나라장터 응답이 늦어요. 잠시 후 다시 해 주세요';
  return '처리하지 못했어요: ' + m.slice(0, 120);
}

function snapshot_() {
  const s = settings_();
  s.tgReady = !!(P.getProperty('TG_TOKEN') && P.getProperty('TG_CHAT_ID'));
  return {
    settings: s,
    watches: watches_(),
    results: results_(100),
    status: {
      lastRun: P.getProperty('lastRunText') || '',
      lastError: P.getProperty('lastErrText') || '',
      callsToday: Number(P.getProperty('calls|' + day_()) || 0),
      trigger: ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'check'),
    },
  };
}

// ════════════════════════ 설정 ════════════════════════

function settings_() {
  let s = {};
  try { s = JSON.parse(P.getProperty('settings') || '{}'); } catch (e) {}
  if (s.ruleVer !== RULE_VER) {
    s.keywords = []; s.institutions = []; s.exclude = []; s.ruleVer = RULE_VER;
    if (!s.myCompanies) s.myCompanies = DEFAULTS.myCompanies.slice();
    if (!s.rivals) s.rivals = DEFAULTS.rivals.slice();
    P.setProperty('settings', JSON.stringify(s));
  }
  return Object.assign({}, DEFAULTS, s);
}

function saveSettings_(inp) {
  const old = settings_();
  const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
  const s = Object.assign({}, old);
  if ('interval' in inp && [1, 5, 10, 15, 30, 60].indexOf(Number(inp.interval)) >= 0) s.interval = Number(inp.interval);
  if ('startHour' in inp) s.startHour = Math.max(0, Math.min(24, Number(inp.startHour) || 0));
  if ('endHour' in inp) s.endHour = Math.max(0, Math.min(24, Number(inp.endHour) || 24));
  ['weekends', 'mail', 'telegram'].forEach(k => { if (k in inp) s[k] = !!inp[k]; });
  ['keywords', 'institutions', 'exclude', 'myCompanies', 'rivals'].forEach(k => { if (k in inp) s[k] = list(inp[k]); });
  if ('kinds' in inp) { const k = list(inp.kinds).filter(x => KIND_NM[x]); if (k.length) s.kinds = k; }
  ['myName', 'myBizno', 'email'].forEach(k => { if (k in inp) s[k] = String(inp[k] || '').trim().slice(0, 80); });
  if (s.startHour >= s.endHour) { s.startHour = old.startHour; s.endHour = old.endHour; }
  P.setProperty('settings', JSON.stringify(s));
  // 확인 간격이 바뀌었거나 트리거가 없으면 다시 건다
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'check');
  if (s.interval !== old.interval || !has) installTrigger_(s.interval);
}

function installTrigger_(min) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'check').forEach(t => ScriptApp.deleteTrigger(t));
  const b = ScriptApp.newTrigger('check').timeBased();
  if (min >= 60) b.everyHours(1); else b.everyMinutes(min);
  b.create();
}

// ════════════════════════ 저장소 (구글 시트) ════════════════════════
// 감시 목록과 받은 결과는 '개찰알림 데이터' 시트에 둔다 (스크립트 속성은 칸당 9KB 제한)

function book_() {
  const id = P.getProperty('SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const ss = SpreadsheetApp.create('개찰알림 데이터');
  ss.getSheets()[0].setName('감시').appendRow(['공고번호', '사업명', '기관', '개찰일시', '상태', '추가', 'json']);
  ss.insertSheet('결과').appendRow(['받은 시각', '키', '상태', '사업명', '기관', '1순위', '투찰률', '우리 순위', '읽음', 'json']);
  P.setProperty('SHEET_ID', ss.getId());
  return ss;
}
function sheet_(name) { return book_().getSheetByName(name); }
function rows_(sh) { const n = sh.getLastRow(); return n < 2 ? [] : sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues(); }

function watches_() {
  return rows_(sheet_('감시')).map(r => { try { return JSON.parse(r[6]); } catch (e) { return null; } }).filter(Boolean);
}
function writeWatches_(list) {
  const sh = sheet_('감시');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 7).clearContent();
  if (!list.length) return;
  sh.getRange(2, 1, list.length, 7).setValues(list.map(w => ["'" + w.no, w.name, w.demand || w.org, w.opengDt, w.status, w.addedAt, JSON.stringify(w)]));
}
function addWatch_(item) {
  if (!item || !item.no) throw new Error('공고 정보가 없어요');
  const list = watches_().filter(w => w.no !== item.no);
  list.unshift({ no: item.no, ord: item.ord || '', name: item.name, org: item.org, demand: item.demand, opengDt: item.opengDt,
    closeDt: item.closeDt, price: item.price, kind: item.kind || 'Servc', urgent: !!item.urgent, url: item.url || '', info: item.info || [],
    status: '대기', addedAt: now_() });
  writeWatches_(list);
}
function removeWatch_(no) { writeWatches_(watches_().filter(w => w.no !== no)); }

function results_(limit) {
  const rs = rows_(sheet_('결과'));
  const out = [];
  for (let i = rs.length - 1; i >= 0 && out.length < limit; i--) {
    try { const r = JSON.parse(rs[i][9]); r.read = rs[i][8] === true || rs[i][8] === 'Y'; out.push(r); } catch (e) {}
  }
  return out;
}
function addResult_(r) {
  const sh = sheet_('결과');
  sh.appendRow([r.at, r.key, r.status, r.name, r.org, r.top ? r.top.name : '', r.top ? r.top.rate : '', r.mine ? r.mine.rank : '', 'N', JSON.stringify(r)]);
  if (sh.getLastRow() > 501) sh.deleteRows(2, sh.getLastRow() - 501);   // 최근 500건만 둔다
}
function markRead_(keys) {
  const sh = sheet_('결과'), rs = rows_(sh);
  if (!rs.length) return;
  const col = rs.map(r => [r[8] === 'Y' || !keys || keys.indexOf(r[1]) >= 0 ? 'Y' : r[8]]);
  sh.getRange(2, 9, col.length, 1).setValues(col);
}

// ════════════════════════ 검색 (입찰공고) ════════════════════════

function search_(text, days, kinds) {
  text = String(text || '').trim();
  days = Math.max(1, Math.min(90, days));
  const now = new Date(), map = {};
  TRACE = [];
  const add = r => {
    const n = mapNotice_(r); if (!n.no) return;
    const old = map[n.no];
    if (!old || String(n.ord) > String(old.ord)) map[n.no] = n;   // 같은 공고는 최신 차수만
  };
  // 공고번호로 찾기 (예: R26BK01777014, R26BK01777014-000)
  const noM = text.replace(/\s/g, '').match(/^([A-Za-z]\d{2}[A-Za-z]{2}\d{6,10}|\d{10,14})(-\d{3})?$/);
  if (noM) {
    kinds.forEach(k => bidCall_(k, { inqryDiv: '2', bidNtceNo: noM[1].toUpperCase() }, 10, 1, '').forEach(add));
    const items = Object.keys(map).map(k => map[k]);
    return { items: items, total: items.length, note: items.length ? '' : traceText_() };
  }
  // 입찰공고 API(2026-11 개편 후)는 긴 기간을 주면 오류 없이 0건을 준다(1일은 되고 7·30일은 0건이었다).
  // → 되는 기간 길이를 알아내(bidWindow_) 그 길이로 잘라 한꺼번에 부른다
  const W = bidWindow_(kinds[0]), wins = [];
  for (let end = +now; end > +now - days * 864e5; end -= W * 864e5) wins.push([new Date(Math.max(end - W * 864e5, +now - days * 864e5)), new Date(end)]);
  const run = field => {
    const list = [];
    kinds.forEach(k => wins.forEach(([b, e]) => {
      const prm = { numOfRows: 100, pageNo: 1, inqryDiv: '1', inqryBgnDt: fmt_(b), inqryEndDt: fmt_(e) };
      if (field) prm[field] = text;
      list.push({ k: k, params: prm });
    }));
    let pref = Number(P.getProperty('bidApi') || 0);
    for (let tryN = 0; tryN < 2; tryN++) {
      const api = BID_APIS[pref], label = api.suffix ? '새 주소(02)' : '옛 주소';
      const res = fetchMany_(list.map(x => ({ url: api.base + 'getBidPblancListInfo' + x.k + 'PPSSrch' + api.suffix, params: x.params })));
      let n = 0, errs = 0, lastErr = '';
      res.forEach((r, i) => {
        if (r.err) { errs++; lastErr = r.err; return; }
        const it = r.body.items, items = Array.isArray(it) ? it : it && it.item ? [].concat(it.item) : [];
        items.forEach(x => { x._kind = list[i].k; add(x); }); n += items.length;
      });
      TRACE.push({ api: label + ' ' + W + '일씩', n: n, calls: res.length, err: errs ? errs + '번 실패: ' + lastErr : '' });
      if (n > 0) { P.setProperty('bidApi', String(pref)); return; }
      pref = 1 - pref;   // 0건이거나 전부 실패면 다른 주소로 한 번 더 (개편 직후 한쪽만 자료가 있을 수 있다)
    }
  };
  if (!text) run(null);
  else {
    run('bidNtceNm');
    // 공고명으로 못 찾았거나 기관 이름처럼 보이면 공고기관·수요기관으로도 찾는다
    if (!Object.keys(map).length || /(부|청|원|처|청|공사|공단|시|군|구|도|센터|연구소|재단|대학교|위원회)$/.test(text)) { run('dminsttNm'); run('ntceInsttNm'); }
  }
  const items = Object.keys(map).map(k => map[k]).sort((a, b) => String(b.postDt).localeCompare(String(a.postDt))).slice(0, 150);
  return { items: items, total: items.length, note: items.length ? '' : traceText_() };
}

/** 입찰공고 API가 받아 주는 기간 길이(일). 조건 없이 1일치 건수를 기준으로, 더 긴 기간이 그 이상을 주면 된다고 본다.
 *  알아낸 값은 1주일 동안 기억한다. 1일치가 0건(연휴 새벽 등)이면 판단하지 않고 1일로 */
function bidWindow_(kind) {
  const memo = String(P.getProperty('bidWin') || '').split('|');
  if (memo[0] && memo[1] && Date.now() - Number(memo[1]) < 7 * 864e5) return Number(memo[0]);
  const api = BID_APIS[Number(P.getProperty('bidApi') || 0)], now = new Date();
  const total = d => { try { return Number(call_(api.base + 'getBidPblancListInfo' + (kind || 'Servc') + 'PPSSrch' + api.suffix,
    { numOfRows: 1, pageNo: 1, inqryDiv: '1', inqryBgnDt: fmt_(new Date(now - d * 864e5)), inqryEndDt: fmt_(now) }).totalCount || 0); } catch (e) { return -1; } };
  const c1 = total(1);
  if (c1 <= 0) return 1;
  const tries = [31, 15, 7, 3, 2];
  for (let i = 0; i < tries.length; i++) {
    if (total(tries[i]) >= c1) { P.setProperty('bidWin', tries[i] + '|' + Date.now()); return tries[i]; }
  }
  P.setProperty('bidWin', '1|' + Date.now());
  return 1;
}

/** 0건일 때 앱에 보여 줄 '서버가 실제로 받은 것' 요약 */
let TRACE = [];
function traceText_() {
  const g = {};
  TRACE.forEach(t => { const k = t.api; g[k] = g[k] || { n: 0, calls: 0, err: '' }; g[k].calls += t.calls || 1; g[k].n += t.n; if (t.err) g[k].err = t.err; });
  return '서버 조회 결과: ' + Object.keys(g).map(k => k + ' ' + g[k].calls + '번 ' + g[k].n + '건' + (g[k].err ? ' (오류: ' + g[k].err.slice(0, 60) + ')' : '')).join(' · ');
}

function mapNotice_(r) {
  const d = noticeInfo_(r);
  return {
    no: String(r.bidNtceNo || '').trim(), ord: String(r.bidNtceOrd || '').trim(), name: r.bidNtceNm || '',
    org: r.ntceInsttNm || '', demand: r.dminsttNm || '', postDt: r.bidNtceDt || '', closeDt: r.bidClseDt || '',
    opengDt: r.opengDt || '', price: Number(r.presmptPrce || r.asignBdgtAmt || 0) || 0, kind: r._kind || 'Servc',
    urgent: d.urgent, url: d.url, info: d.sections,
  };
}

/** 나라장터 '공고일반' 표처럼 정리한 공고 정보.
 *  API 필드 이름이 확실하지 않은 칸(검사·검수·낙찰방법세부기준·계약구분)은 후보 이름을 차례로 보고, 값이 없으면 칸을 숨긴다.
 *  실제 필드 이름은 inspectNotice('공고번호') 를 실행하면 실행 기록에 모두 찍힌다 */
function noticeInfo_(r) {
  const pick = keys => { for (let i = 0; i < keys.length; i++) { const v = r[keys[i]]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; };
  const yn = (v, y, n) => v === 'Y' ? y : v === 'N' ? n : '';
  const money = v => { const n = Number(v); return n ? n.toLocaleString('ko-KR') + '원' : ''; };
  const kind = pick(['ntceKindNm']), rgst = pick(['rgstTyNm']);
  const allText = [r.bidNtceNm, kind, rgst, pick(['ntceDivNm', 'bidNtceSttusNm'])].join(' ');
  const urgent = /긴급/.test(allText) || pick(['emrgncyNtceYn', 'urgntNtceYn', 'emrgncyYn']) === 'Y';
  const intl = pick(['intrntnlDivNm', 'intrbidDivNm']) || yn(pick(['intrbidYn']), '국제입찰', '국내입찰');
  const ofcl = [pick(['ntceInsttOfclNm']), pick(['ntceInsttOfclTelNo'])].filter(Boolean).join(' · ');
  const sections = [
    { title: '공고일반', rows: [
      ['공고종류', kind && rgst && kind !== rgst ? kind + '(' + rgst + ')' : kind || rgst],
      ['게시일시', pick(['bidNtceDt', 'rgstDt'])],
      ['입찰공고번호', (r.bidNtceNo || '') + (r.bidNtceOrd ? ' - ' + r.bidNtceOrd : '')],
      ['참조번호', pick(['refNo'])],
      ['검사', pick(['inspctInsttNm', 'insptInsttNm', 'inspctNm', 'chckInsttNm', 'exmnInsttNm'])],
      ['검수', pick(['acptncInsttNm', 'inspctAcptncInsttNm', 'acptnInsttNm', 'gdsAcptncInsttNm'])],
      ['입찰방식', pick(['bidMethdNm'])],
      ['낙찰방법', pick(['sucsfbidMthdNm', 'bidwinrDcsnMthdNm'])],
      ['낙찰방법세부기준', pick(['sucsfbidMthdDtlNm', 'bidwinrDcsnMthdDtlNm', 'sucsfbidDtlMthdNm', 'sucsfbidMthdDtlCntnts'])],
      ['계약방법', pick(['cntrctCnclsMthdNm'])],
      ['계약구분', pick(['cntrctDivNm', 'cntrctTyNm', 'cntrctKindNm', 'lngtrmCtnuDivNm'])],
      ['국제입찰구분', intl],
      ['채권자명', pick(['crdtrNm'])],
    ] },
    { title: '기관·담당자', rows: [
      ['공고기관', pick(['ntceInsttNm'])], ['수요기관', pick(['dminsttNm'])], ['집행관', pick(['exctvNm'])], ['담당자', ofcl],
    ] },
    { title: '일정·금액', rows: [
      ['입찰개시', pick(['bidBeginDt'])], ['입찰마감', pick(['bidClseDt'])], ['개찰일시', pick(['opengDt'])], ['개찰장소', pick(['opengPlce'])],
      ['추정가격', money(pick(['presmptPrce']))], ['배정예산', money(pick(['asignBdgtAmt']))],
      ['낙찰하한율', pick(['sucsfbidLwltRate']) ? pick(['sucsfbidLwltRate']) + '%' : ''],
      ['업무구분', pick(['srvceDivNm'])], ['예정가격 방식', pick(['prearngPrceDcsnMthdNm'])],
    ] },
  ].map(sec => ({ title: sec.title, rows: sec.rows.filter(x => x[1]) })).filter(sec => sec.rows.length);
  return { urgent: urgent, url: pick(['bidNtceDtlUrl', 'bidNtceUrl']), sections: sections };
}

/** 공고 하나의 정보 (감시 목록에 있으면 그것, 없으면 나라장터에서 공고번호로 조회) */
function notice_(no, kind) {
  const w = watches_().filter(x => x.no === no && x.info)[0];
  if (w) return { info: w.info, url: w.url || '', urgent: !!w.urgent };
  const pref = Number(P.getProperty('bidApi') || 0), order = [pref, 1 - pref];
  for (let i = 0; i < order.length; i++) {
    const api = BID_APIS[order[i]];
    try {
      const items = fetchAll_(api.base + 'getBidPblancListInfo' + (kind || 'Servc') + api.suffix, { inqryDiv: '2', bidNtceNo: no }, 10, 1);
      if (!items.length) continue;
      items.sort((a, b) => String(b.bidNtceOrd).localeCompare(String(a.bidNtceOrd)));
      const d = noticeInfo_(items[0]);
      return { info: d.sections, url: d.url, urgent: d.urgent };
    } catch (e) { if (/LIMITED|한도|SERVICE_KEY|등록되지/i.test(String(e.message))) throw e; }
  }
  return { info: [], url: '', urgent: false };
}

/** 필드 이름 확인용: 공고 하나의 원본 필드를 모두 실행 기록에 찍는다 (예: inspectNotice('R26BK01777014')) */
function inspectNotice(no) {
  no = no || 'R26BK01777014';
  const api = BID_APIS[Number(P.getProperty('bidApi') || 0)];
  const items = fetchAll_(api.base + 'getBidPblancListInfoServc' + api.suffix, { inqryDiv: '2', bidNtceNo: no }, 10, 1);
  if (!items.length) { console.log('공고를 찾지 못했어요: ' + no); return; }
  const r = items[items.length - 1];
  Object.keys(r).filter(k => r[k] !== '' && r[k] != null).forEach(k => console.log(k + ' = ' + r[k]));
}

/** 입찰공고 PPSSrch 호출 — 새 이름(02) → 옛 이름 순서로 시도하고 되는 쪽을 기억 */
/** 입찰공고 호출 — 새 주소(02)와 옛 주소를 차례로. '오류'뿐 아니라 '0건'이어도 다음 주소를 시도한다
 *  (개편 직후에는 한쪽이 정상 응답 + 0건을 줄 수 있다). 자료가 나온 쪽을 기억해 다음부터 먼저 쓴다.
 *  op: 'PPSSrch'(검색 조건) 또는 ''(공고번호 조회) */
function bidCall_(kind, params, rows, pages, op) {
  op = op == null ? 'PPSSrch' : op;
  const pref = Number(P.getProperty('bidApi') || 0), order = [pref, 1 - pref];
  let lastErr = null, anyOk = false;
  for (let i = 0; i < order.length; i++) {
    const api = BID_APIS[order[i]], label = api.suffix ? '새 주소(02)' : '옛 주소';
    try {
      const items = fetchAll_(api.base + 'getBidPblancListInfo' + kind + op + api.suffix, params, rows, pages);
      TRACE.push({ api: label, n: items.length });
      anyOk = true;
      if (!items.length) continue;
      if (order[i] !== pref) P.setProperty('bidApi', String(order[i]));
      items.forEach(x => { x._kind = kind; });
      return items;
    } catch (e) {
      lastErr = e; TRACE.push({ api: label, n: 0, err: String(e.message || e) });
      if (/LIMITED|한도/i.test(String(e.message))) throw e;
    }
  }
  if (!anyOk && lastErr) throw lastErr;
  return [];
}

/** 검색이 안 될 때 실행: 주소·조건별로 실제 응답을 실행 기록에 찍는다 (예: debugSearch('해양예보')) */
function debugSearch(text) {
  text = text || '해양예보';
  const now = new Date(), d1 = new Date(now - 864e5), d7 = new Date(now - 7 * 864e5), d30 = new Date(now - 30 * 864e5);
  // 하루치 결과에서 낱말 하나를 뽑아 '이름 조건'이 동작하는지 본다
  let word = '', sample = '';
  try {
    const b = call_(BID_APIS[0].base + 'getBidPblancListInfoServcPPSSrch02', { numOfRows: 5, pageNo: 1, inqryDiv: '1', inqryBgnDt: fmt_(d1), inqryEndDt: fmt_(now) });
    const it = b.items, items = Array.isArray(it) ? it : it && it.item ? [].concat(it.item) : [];
    if (items[0]) { sample = items[0].bidNtceNm; word = String(sample).replace(/[^가-힣A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 2).pop() || ''; }
  } catch (e) { console.log('하루치 조회 실패: ' + e.message); }
  console.log('시험 낱말: "' + word + '" (원래 공고명: ' + sample + ')');
  const tries = [
    ['30일 · 조건 없음', { inqryDiv: '1', inqryBgnDt: fmt_(d30), inqryEndDt: fmt_(now) }],
    ['7일 · 조건 없음', { inqryDiv: '1', inqryBgnDt: fmt_(d7), inqryEndDt: fmt_(now) }],
    ['1일 · 공고명 "' + word + '"', { inqryDiv: '1', inqryBgnDt: fmt_(d1), inqryEndDt: fmt_(now), bidNtceNm: word }],
    ['30일 · 공고명 "' + word + '"', { inqryDiv: '1', inqryBgnDt: fmt_(d30), inqryEndDt: fmt_(now), bidNtceNm: word }],
    ['30일 · 공고명 "' + text + '"', { inqryDiv: '1', inqryBgnDt: fmt_(d30), inqryEndDt: fmt_(now), bidNtceNm: text }],
    ['30일 · 공고명 "유지관리"', { inqryDiv: '1', inqryBgnDt: fmt_(d30), inqryEndDt: fmt_(now), bidNtceNm: '유지관리' }],
    ['30일 · 공고기관 "부산지방조달청"', { inqryDiv: '1', inqryBgnDt: fmt_(d30), inqryEndDt: fmt_(now), ntceInsttNm: '부산지방조달청' }],
    ['30일 · 수요기관 "국립해양조사원"', { inqryDiv: '1', inqryBgnDt: fmt_(d30), inqryEndDt: fmt_(now), dminsttNm: '국립해양조사원' }],
  ];
  tries.forEach(([label, prm]) => {
    try {
      const body = call_(BID_APIS[0].base + 'getBidPblancListInfoServcPPSSrch02', Object.assign({ numOfRows: 3, pageNo: 1 }, prm));
      const it = body.items, items = Array.isArray(it) ? it : it && it.item ? [].concat(it.item) : [];
      console.log('✓ ' + label + ' → 전체 ' + (body.totalCount || 0) + '건 ' + items.slice(0, 2).map(x => '[' + x.bidNtceNo + '] ' + x.bidNtceNm).join(' / '));
    } catch (e) { console.log('✗ ' + label + ' → ' + e.message); }
  });
  // 공고번호로 받은 이 공고의 게시일·등록일 (기간 조건과 비교용)
  try {
    const b = call_(BID_APIS[0].base + 'getBidPblancListInfoServc02', { numOfRows: 3, pageNo: 1, inqryDiv: '2', bidNtceNo: 'R26BK01777014' });
    const it = b.items, x = (Array.isArray(it) ? it : it && it.item ? [].concat(it.item) : [])[0] || {};
    console.log('이 공고: 게시 ' + x.bidNtceDt + ' · 등록 ' + x.rgstDt + ' · 변경 ' + (x.chgDt || '-') + ' · 공고기관 ' + x.ntceInsttNm + ' · 수요기관 ' + x.dminsttNm);
  } catch (e) { console.log('공고번호 조회 실패: ' + e.message); }
}

// ════════════════════════ 개찰결과 감시 ════════════════════════

/** 트리거가 부르는 함수 */
function check() { check_(false); }

function check_(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(force ? 20000 : 1000)) return 0;
  let newCount = 0;
  try {
    const now = new Date(), s = settings_();
    if (!force && !activeNow_(now, s)) return 0;
    const W = watches_();
    const found = {};
    const add = (r, via) => { const k = keyOf_(r); if (!found[k]) { r._via = via; found[k] = r; } else if (via && !found[k]._via) found[k]._via = via; };

    // 1) 빠른 감시: 지난 확인 이후 입력된 개찰결과 전체 (10분 겹치게)
    const last = Number(P.getProperty('lastRun') || 0);
    const from = new Date(Math.max(last ? last - 10 * 60e3 : 0, now - 90 * 60e3));
    s.kinds.forEach(k => {
      fetchAll_(SCRS + 'getOpengResultListInfo' + k, { inqryDiv: '1', inqryBgnDt: fmt_(from), inqryEndDt: fmt_(now) }, 20, 15)
        .forEach(r => add(r, W.some(w => w.no === String(r.bidNtceNo).trim()) ? '감시 공고' : ''));
    });

    // 2) 안전망: 감시 공고 중 개찰 시각이 지난 것 (30분마다)
    const lastSweep = Number(P.getProperty('lastSweep') || 0);
    if (force || now - lastSweep >= 30 * 60e3) {
      const old = fmt_(new Date(now - 14 * 864e5));
      W.filter(w => { const o = String(w.opengDt || '').replace(/\D/g, '').slice(0, 12); return w.status === '대기' && (!o || (o <= fmt_(now) && o >= old)); })
        .forEach(w => {
          fetchAll_(SCRS + 'getOpengResultListInfo' + (w.kind || 'Servc') + 'PPSSrch', { inqryDiv: '3', bidNtceNo: w.no }, 20, 1)
            .forEach(r => { r._via = ''; add(r, '감시 공고'); });
        });
      P.setProperty('lastSweep', String(now.getTime()));
    }
    P.setProperty('lastRun', String(now.getTime()));
    P.setProperty('lastRunText', Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm'));

    // 3) 처음 보는 결과만. 감시 공고가 아니면 참가업체 목록을 받아 우리 회사·동종업체가 있을 때만 알린다
    const seen = {};
    rows_(sheet_('결과')).forEach(r => { seen[r[1] + '|' + r[2]] = 1; });
    const cache = CacheService.getScriptCache();   // 확인했지만 알릴 것이 없던 결과 (6시간 기억 → 같은 결과를 다시 묻지 않음)
    const todo = Object.keys(found).filter(k => {
      const st = found[k].progrsDivCdNm || '개찰';
      return !seen[k + '|' + st] && !cache.get('chk|' + k + '|' + st);
    });
    // 참가업체 목록이 필요한 것(개찰완료)을 한꺼번에(병렬로) 받는다
    const need = todo.filter(k => (found[k].progrsDivCdNm || '') === '개찰완료');
    const lists = biddersMany_(need.map(k => found[k]), s);
    let changed = false;
    todo.forEach(k => {
      const raw = found[k], status = raw.progrsDivCdNm || '개찰';
      let bd = lists[k];
      // 유찰·재입찰은 참가업체 목록 대신 1순위 정보(opengCorpInfo)만 본다
      if (!bd) { const t = parseTop_(raw.opengCorpInfo); bd = t ? [markCo_({ rank: 1, name: t.name, amount: Number(t.amount) || 0, rate: Number(t.rate) || 0, rmrk: '' }, s)] : []; }
      const hasMine = bd.some(b => b.mine), hasRival = bd.some(b => b.rival);
      if (!raw._via) raw._via = hasMine ? '우리 회사 참여' : hasRival ? '동종업체 참여' : '';
      if (!raw._via) { cache.put('chk|' + k + '|' + status, '1', 21600); return; }
      const r = buildResult_(raw, s, bd);
      addResult_(r);
      notify_(r, s);
      newCount++;
      W.forEach(w => { if (w.no === r.no) { w.status = status; changed = true; } });
    });
    if (changed) writeWatches_(W);
    P.deleteProperty('lastErrText');
  } catch (e) {
    console.error(e);
    P.setProperty('lastErrText', Utilities.formatDate(new Date(), TZ, 'MM/dd HH:mm') + ' ' + plain_(e));
    reportError_(e);
    if (force) throw e;
  } finally {
    lock.releaseLock();
  }
  return newCount;
}


function buildResult_(raw, s, given) {
  const top = parseTop_(raw.opengCorpInfo);
  const r = {
    key: keyOf_(raw), at: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
    no: String(raw.bidNtceNo).trim(), ord: raw.bidNtceOrd || '', cls: raw.bidClsfcNo || '', rbid: raw.rbidNo || '',
    name: raw.bidNtceNm || '', org: raw.ntceInsttNm || '', demand: raw.dminsttNm || '', opengDt: raw.opengDt || '',
    status: raw.progrsDivCdNm || '개찰', prtcpt: Number(raw.prtcptCnum || 0), via: raw._via || '',
    top: top ? { name: top.name, amount: Number(top.amount) || 0, rate: Number(top.rate) || 0 } : null, mine: null, bidders: [],
  };
  const all = given || (r.status === '개찰완료' ? bidders_(r, s) : []);
  const mine = all.filter(b => b.mine)[0];
  if (mine) r.mine = { rank: mine.rank, amount: mine.amount, rate: mine.rate, name: mine.name };
  r.ours = all.filter(b => b.mine).map(b => ({ name: b.name, rank: b.rank, rate: b.rate }));
  r.rivals = all.filter(b => b.rival).map(b => ({ name: b.name, rank: b.rank, rate: b.rate }));
  // 상위 10곳 + 그 밖의 우리·동종업체
  r.bidders = all.slice(0, 10).concat(all.slice(10).filter(b => b.mine || b.rival));
  return r;
}

/** 업체 이름 비교용: (주)·주식회사·빈칸·대소문자를 빼고 비교 */
function coNorm_(x) { return String(x || '').replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\s/g, '').toLowerCase(); }
function markCo_(b, s) {
  const n = coNorm_(b.name), biz = String(s.myBizno || '').replace(/\D/g, '');
  const mineList = (s.myCompanies && s.myCompanies.length ? s.myCompanies : [s.myName]).map(coNorm_).filter(Boolean);
  b.mine = (biz && String(b.bizno || '').replace(/\D/g, '') === biz) || mineList.some(m => n.indexOf(m) >= 0);
  b.rival = !b.mine && (s.rivals || []).map(coNorm_).filter(Boolean).some(m => n.indexOf(m) >= 0);
  return b;
}

/** 여러 개찰결과의 참가업체 목록을 한꺼번에(10개씩 병렬). 결과: { 키: [업체…] } */
function biddersMany_(raws, s) {
  const out = {};
  if (!raws.length) return out;
  const res = fetchMany_(raws.map(r => ({ url: SCRS + 'getOpengResultListInfoOpengCompt',
    params: Object.assign({ numOfRows: 200, pageNo: 1, bidNtceNo: String(r.bidNtceNo).trim() }, r.bidNtceOrd ? { bidNtceOrd: r.bidNtceOrd } : {}) })));
  res.forEach((x, i) => {
    if (x.err) { console.warn('참가업체 조회 실패 ' + raws[i].bidNtceNo + ': ' + x.err); return; }
    const r = raws[i], it = x.body.items, items = Array.isArray(it) ? it : it && it.item ? [].concat(it.item) : [];
    out[keyOf_(r)] = items
      .filter(b => (!r.bidClsfcNo || !b.bidClsfcNo || b.bidClsfcNo === r.bidClsfcNo) && (!r.rbidNo || !b.rbidNo || b.rbidNo === r.rbidNo))
      .map(b => markCo_({ rank: Number(b.opengRank) || 0, name: b.prcbdrNm || '', bizno: b.prcbdrBizno || '', amount: Number(b.bidprcAmt) || 0,
        rate: Number(b.bidprcrt) || 0, rmrk: String(b.rmrk || '').trim() }, s))
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  });
  return out;
}

/** 업체별 개찰순위 */
function bidders_(r, s) {
  try {
    const p = { bidNtceNo: r.no };
    if (r.ord) p.bidNtceOrd = r.ord;
    return fetchAll_(SCRS + 'getOpengResultListInfoOpengCompt', p, 100, 3)
      .filter(b => (!r.cls || !b.bidClsfcNo || b.bidClsfcNo === r.cls) && (!r.rbid || !b.rbidNo || b.rbidNo === r.rbid))
      .map(b => markCo_({ rank: Number(b.opengRank) || 0, name: b.prcbdrNm || '', bizno: b.prcbdrBizno || '', amount: Number(b.bidprcAmt) || 0,
        rate: Number(b.bidprcrt) || 0, rmrk: String(b.rmrk || '').trim() }, s))
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  } catch (e) { console.warn('업체별 순위 조회 실패: ' + e); return []; }
}

/** 앱에서 상세를 열 때 업체별 순위가 없으면 그때 받는다 */
function detail_(key, no, ord) {
  const s = settings_();
  const parts = String(key || '').split('|');
  return bidders_({ no: no || parts[0], ord: ord || parts[1] || '', cls: parts[2] || '', rbid: parts[3] || '' }, s).slice(0, 30);
}

// ════════════════════════ 알림 보내기 ════════════════════════

function notify_(r, s) {
  const sent = { mail: false, tg: false, tgErr: '' };
  const subject = '[' + r.status + '] ' + r.name
    + (r.top ? ' — 1순위 ' + r.top.name + ' (' + rate_(r.top.rate) + ')' : '')
    + (r.mine ? ' / 우리 ' + (r.mine.rank || '-') + '위' : '')
    + (!r.mine && (r.rivals || []).length ? ' / 동종 ' + r.rivals[0].name.replace(/\(주\)|주식회사/g, '').trim() + ' ' + (r.rivals[0].rank || '-') + '위' : '');
  const lines = [
    '공고번호: ' + r.no + '-' + (r.ord || '000') + ' · ' + r.via,
    '기관: ' + r.org + (r.demand && r.demand !== r.org ? ' / ' + r.demand : ''),
    '개찰: ' + r.opengDt + ' · 참가 ' + r.prtcpt + '개사',
  ];
  if (r.top) lines.push('1순위: ' + r.top.name + ' ' + won_(r.top.amount) + ' (' + rate_(r.top.rate) + ')');
  if ((r.ours || []).length) lines.push('우리 회사: ' + r.ours.map(b => b.name + ' ' + (b.rank || '순위없음') + '위 (' + rate_(b.rate) + ')').join(' · '));
  else if (r.mine) lines.push('우리 회사: ' + (r.mine.rank || '순위없음') + '위 ' + won_(r.mine.amount) + ' (' + rate_(r.mine.rate) + ')');
  if ((r.rivals || []).length) lines.push('동종업체: ' + r.rivals.map(b => b.name + ' ' + (b.rank || '순위없음') + '위 (' + rate_(b.rate) + ')').join(' · '));

  if (s.mail) {
    const table = r.bidders.length ? '<table cellpadding="5" style="border-collapse:collapse;font-size:13px">'
      + '<tr style="background:#e9f2fa"><th>순위</th><th align="left">업체</th><th align="right">투찰금액</th><th align="right">투찰률</th></tr>'
      + r.bidders.map(b => '<tr style="border-top:1px solid #ddd' + (b.mine ? ';background:#fff4c2;font-weight:bold' : b.rival ? ';background:#e1eefb' : '') + '"><td>' + (b.rank || '-') + '</td><td>'
        + esc_(b.name) + (b.rmrk && b.rmrk !== '정상' ? ' <small>(' + esc_(b.rmrk) + ')</small>' : '') + '</td><td align="right">' + won_(b.amount) + '</td><td align="right">' + rate_(b.rate) + '</td></tr>').join('')
      + '</table>' : '';
    MailApp.sendEmail({
      to: s.email || Session.getEffectiveUser().getEmail(), subject: subject.slice(0, 250),
      body: lines.join('\n') + '\n\n' + APP_URL,
      htmlBody: '<div style="font-family:sans-serif"><h3 style="color:#2b6ca3;margin:0 0 8px">' + esc_(r.name) + '</h3><p>'
        + lines.map(esc_).join('<br>') + '</p>' + table + '<p><a href="' + APP_URL + '">개찰알림 앱에서 보기</a></p></div>',
    });
    sent.mail = true;
  }
  if (s.telegram) {
    sent.tg = tg_(subject + '\n\n' + lines.join('\n') + (r.bidders.length ? '\n\n' + r.bidders.slice(0, 5).map(b =>
      (b.rank || '-') + '. ' + b.name + ' ' + rate_(b.rate) + (b.mine ? ' ◀ 우리' : b.rival ? ' ◀ 동종' : '')).join('\n') : '') + '\n\n' + APP_URL);
    if (!sent.tg) sent.tgErr = P.getProperty('TG_TOKEN') ? '봇에게 먼저 말을 걸고 testTelegram 을 실행해 보세요' : 'TG_TOKEN 이 없어요';
  }
  return sent;
}

/** 텔레그램 (스크립트 속성 TG_TOKEN · TG_CHAT_ID). 채팅 번호가 없으면 봇에게 온 메시지에서 찾아 기억한다 */
function tg_(text) {
  const token = P.getProperty('TG_TOKEN'); if (!token) return false;
  let chat = P.getProperty('TG_CHAT_ID');
  if (!chat) {
    try {
      const u = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true }).getContentText());
      const m = (u.result || []).map(x => x.message || x.channel_post).filter(Boolean).pop();
      if (m) { chat = String(m.chat.id); P.setProperty('TG_CHAT_ID', chat); }
    } catch (e) {}
  }
  if (!chat) return false;
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', muteHttpExceptions: true, payload: { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: 'true' },
  });
  if (r.getResponseCode() !== 200) console.warn('텔레그램 보내기 실패: ' + r.getContentText());
  return r.getResponseCode() === 200;
}

/** 텔레그램만 따로 시험 (나라장터 API 없이). 실패하면 이유를 쉬운 말로 로그에 남긴다 */
function testTelegram() {
  const token = (P.getProperty('TG_TOKEN') || '').trim();
  if (!token) throw new Error('스크립트 속성에 TG_TOKEN(봇 토큰)이 없어요');
  const me = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getMe', { muteHttpExceptions: true }).getContentText());
  if (!me.ok) throw new Error('봇 토큰이 맞지 않아요. BotFather가 준 토큰 전체(숫자:영문)를 앞뒤 빈칸 없이 넣어 주세요');
  console.log('봇 확인: @' + me.result.username);
  let chat = (P.getProperty('TG_CHAT_ID') || '').trim();
  if (!chat) {
    const u = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true }).getContentText());
    const m = (u.result || []).map(x => x.message || x.channel_post).filter(Boolean).pop();
    if (!m) throw new Error('@' + me.result.username + ' 대화방에서 시작(/start)을 누르거나 아무 말이나 보낸 뒤 다시 실행해 주세요');
    chat = String(m.chat.id); P.setProperty('TG_CHAT_ID', chat);
    console.log('대화방 번호를 찾아 저장했어요: ' + chat);
  }
  const r = JSON.parse(UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', muteHttpExceptions: true, payload: { chat_id: chat, text: '[개찰알림] 텔레그램 연결 시험이에요. 이 메시지가 보이면 성공!' },
  }).getContentText());
  if (r.ok) { console.log('보냈어요. @' + me.result.username + ' 대화방을 확인하세요'); return; }
  const d = String(r.description || '');
  if (/chat not found/i.test(d)) throw new Error('대화방(' + chat + ')을 못 찾았어요. @' + me.result.username + ' 대화방에서 시작(/start)을 누른 뒤, TG_CHAT_ID를 지우고 다시 실행해 주세요');
  if (/blocked/i.test(d)) throw new Error('봇이 차단돼 있어요. 텔레그램에서 @' + me.result.username + ' 차단을 풀어 주세요');
  throw new Error('텔레그램 오류: ' + d);
}

/** 같은 오류는 하루 한 번만 메일로 */
function reportError_(e) {
  const msg = plain_(e), key = day_() + '|' + msg.slice(0, 60);
  if (P.getProperty('lastErrMail') === key) return;
  P.setProperty('lastErrMail', key);
  const s = settings_();
  try { MailApp.sendEmail(s.email || Session.getEffectiveUser().getEmail(), '[개찰알림 오류] ' + msg.slice(0, 80), msg + '\n\n' + (e && e.stack || '')); } catch (x) {}
  if (s.telegram) tg_('[개찰알림 오류] ' + msg);
}

// ════════════════════════ 위젯 ════════════════════════

function widget_() {
  const R = results_(20), W = watches_(), today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const next = W.filter(w => w.status === '대기' && w.opengDt && String(w.opengDt) >= Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'))
    .sort((a, b) => String(a.opengDt).localeCompare(String(b.opengDt)))[0];
  return {
    unread: R.filter(r => !r.read).length,
    today: R.filter(r => String(r.at).indexOf(today) === 0).length,
    waiting: W.filter(w => w.status === '대기').length,
    next: next ? { name: next.name, opengDt: next.opengDt } : null,
    items: R.slice(0, 6).map(r => ({ key: r.key, name: r.name, org: r.org, status: r.status, at: r.at, read: r.read,
      top: r.top ? r.top.name : '', rate: r.top ? r.top.rate : 0, mine: r.mine ? r.mine.rank : 0 })),
    lastRun: P.getProperty('lastRunText') || '',
  };
}

// ════════════════════════ 나라장터 API ════════════════════════

function fetchAll_(url, params, rows, pages) {
  rows = rows || 50; pages = pages || 5;
  let out = [];
  for (let page = 1; page <= pages; page++) {
    const body = call_(url, Object.assign({ numOfRows: rows, pageNo: page }, params));
    const it = body.items;
    const items = Array.isArray(it) ? it : it && it.item ? [].concat(it.item) : [];
    out = out.concat(items);
    if (items.length < rows || out.length >= Number(body.totalCount || 0)) break;
  }
  return out;
}

function url_(url, params) {
  // 다른 앱(올포오션 등)과 같은 인증키를 쓰므로 속성 이름은 둘 다 받는다
  const key = P.getProperty('G2B_KEY') || P.getProperty('DATA_GO_KR_KEY');
  if (!key) throw new Error('스크립트 속성 G2B_KEY(공공데이터포털 인증키)가 없어요');
  const q = Object.keys(params).filter(k => params[k] !== '' && params[k] != null).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  return url + '?serviceKey=' + (key.indexOf('%') >= 0 ? key : encodeURIComponent(key)) + '&type=json&' + q;
}
function count_(n) { const ck = 'calls|' + day_(); P.setProperty(ck, String(Number(P.getProperty(ck) || 0) + n)); }

/** 여러 조회를 한꺼번에(병렬로) — 10개씩 묶어 보낸다. 결과는 [{ body } 또는 { err }] */
function fetchMany_(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 10) {
    const part = list.slice(i, i + 10);
    count_(part.length);
    const res = UrlFetchApp.fetchAll(part.map(x => ({ url: url_(x.url, x.params), muteHttpExceptions: true })));
    res.forEach((r, k) => {
      try { out.push({ body: parse_(r, part[k].url) }); }
      catch (e) {
        if (/LIMITED|한도/i.test(String(e.message))) throw e;
        out.push({ err: String(e.message || e) });
      }
    });
  }
  return out;
}

function call_(url, params) {
  const full = url_(url, params);
  count_(1);
  let res;
  for (let i = 0; i < 3; i++) {
    res = UrlFetchApp.fetch(full, { muteHttpExceptions: true });
    if (res.getResponseCode() < 500) break;
    Utilities.sleep(1500 * (i + 1));
  }
  return parse_(res, url);
}

function parse_(res, url) {
  const text = res.getContentText();
  if (res.getResponseCode() === 404) throw new Error('없는 주소 (404): ' + String(url).split('/').pop());
  if (res.getResponseCode() >= 500) throw new Error('나라장터 서버 오류 ' + res.getResponseCode());
  // 키 오류·호출 한도는 JSON 대신 XML로 온다
  if (/^\s*</.test(text)) { const m = text.match(/<(returnAuthMsg|errMsg|resultMsg)>([^<]*)</); throw new Error(m ? m[2] : 'XML 응답: ' + text.slice(0, 120)); }
  const j = JSON.parse(text);
  const g = j.OpenAPI_ServiceResponse && j.OpenAPI_ServiceResponse.cmmMsgHeader;
  if (g) throw new Error(g.returnAuthMsg || g.errMsg || '인증 오류');
  const h = (j.response || j).header || {};
  if (h.resultCode && !/^0?0$/.test(String(h.resultCode))) throw new Error(h.resultCode + ' ' + (h.resultMsg || ''));
  return (j.response || j).body || {};
}

// ════════════════════════ 도우미 ════════════════════════

function keyOf_(r) { return [String(r.bidNtceNo).trim(), r.bidNtceOrd || '', r.bidClsfcNo || '', r.rbidNo || ''].join('|'); }
function parseTop_(s) {
  if (!s) return null;
  const p = String(s).split('^');
  return { name: p[0] || '', bizno: p[1] || '', ceo: p[2] || '', amount: p[3] || '', rate: p[4] || '' };
}
function activeNow_(d, s) {
  if (s.weekends) return true;
  const dow = Number(Utilities.formatDate(d, TZ, 'u')), h = Number(Utilities.formatDate(d, TZ, 'H'));
  return dow <= 5 && h >= s.startHour && h < s.endHour;
}
function fmt_(d) { return Utilities.formatDate(d, TZ, 'yyyyMMddHHmm'); }
function day_() { return Utilities.formatDate(new Date(), TZ, 'yyyyMMdd'); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function won_(v) { const n = Number(v); return n ? n.toLocaleString('ko-KR') + '원' : '-'; }
function rate_(v) { const n = Number(v); return n ? n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%' : '-'; }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ════════════════════════ 직접 실행하는 함수 ════════════════════════

/** ① 처음 한 번: 연결 암호·데이터 시트·자동 확인을 만들고, 휴대폰에서 누를 연결 링크를 보여 줌 */
function setup() {
  if (!P.getProperty('G2B_KEY') && !P.getProperty('DATA_GO_KR_KEY')) throw new Error('먼저 프로젝트 설정 → 스크립트 속성에 G2B_KEY(공공데이터포털 인증키)를 넣어 주세요');
  if (!P.getProperty('APP_TOKEN')) P.setProperty('APP_TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  book_();
  installTrigger_(settings_().interval);
  P.setProperty('lastRun', String(Date.now()));
  const url = ScriptApp.getService().getUrl();
  if (!url) { console.log('아직 웹 앱으로 배포하지 않았어요. 배포 → 새 배포 → 웹 앱(실행: 나, 액세스: 모든 사용자) 후 setup을 다시 실행하세요.'); return; }
  const link = APP_URL + '#setup=' + encodeURIComponent(Utilities.base64Encode(JSON.stringify({ url: url, token: P.getProperty('APP_TOKEN') }), Utilities.Charset.UTF_8));
  console.log('자동 확인을 켰어요 (' + settings_().interval + '분마다).');
  console.log('▼ 아래 링크를 휴대폰에서 열면 앱이 서버에 연결돼요 (홈 화면 앱은 앱 안 설정 탭에 주소·암호를 넣어도 돼요)');
  console.log(link);
  console.log('서버 주소: ' + url);
  console.log('연결 암호: ' + P.getProperty('APP_TOKEN'));
  console.log('데이터 시트: ' + book_().getUrl());
}

/** ② 키 확인: 최근 24시간 용역 개찰결과 몇 건을 로그에 찍음 */
function testApi() {
  const now = new Date();
  const items = fetchAll_(SCRS + 'getOpengResultListInfoServcPPSSrch', { inqryDiv: '2', inqryBgnDt: fmt_(new Date(now - 864e5)), inqryEndDt: fmt_(now) }, 10, 1);
  console.log('개찰결과 API 정상 · 최근 24시간 ' + items.length + '건(첫 페이지)');
  items.forEach(r => console.log([r.opengDt, r.progrsDivCdNm, r.bidNtceNo, r.bidNtceNm].join(' | ')));
  const found = search_('', 3, ['Servc']);
  console.log('입찰공고 검색 API 정상 · 최근 3일 ' + found.total + '건 (' + (P.getProperty('bidApi') === '1' ? '옛 주소' : '새 주소 02') + ')');
}

/** ③ 시험 알림: 최근 개찰결과 1건으로 메일·텔레그램을 보내 봄 (결과 목록에는 저장하지 않음) */
function testNotify() {
  const now = new Date(), s = settings_();
  let items = [];
  for (let d = 0; d < 4 && !items.length; d++) items = fetchAll_(SCRS + 'getOpengResultListInfoServcPPSSrch', { inqryDiv: '2', inqryBgnDt: fmt_(new Date(now - (d + 1) * 864e5)), inqryEndDt: fmt_(new Date(now - d * 864e5)) }, 10, 1);
  const raw = items.filter(x => x.progrsDivCdNm === '개찰완료')[0] || items[0];
  let r;
  if (raw) { raw._via = '시험'; r = buildResult_(raw, s); r.name = '[시험] ' + r.name; }
  else {
    // 주말·연휴처럼 최근 개찰결과가 없으면 예시 내용으로 보낸다 (알림 경로만 확인)
    r = { key: 'TEST', at: now_(), no: 'TEST', ord: '000', name: '[시험] 개찰알림 연결 확인', org: '개찰알림', demand: '', opengDt: now_(),
      status: '시험', prtcpt: 0, via: '시험', top: null, mine: null, bidders: [] };
  }
  return notify_(r, Object.assign({}, s, { mail: s.mail || !s.telegram }));
}

/** 자동 확인 끄기 */
function stop() { ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'check').forEach(t => ScriptApp.deleteTrigger(t)); }
