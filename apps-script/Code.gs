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
  keywords: ['GIS', '공간정보', '해양'], institutions: [], exclude: [],
  myName: '올포랜드', myBizno: '', mail: true, email: '', telegram: true,
};
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
    if (a === 'test') { testNotify(); return ok_(snapshot_()); }
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
  ['keywords', 'institutions', 'exclude'].forEach(k => { if (k in inp) s[k] = list(inp[k]); });
  if ('kinds' in inp) { const k = list(inp.kinds).filter(x => KIND_NM[x]); if (k.length) s.kinds = k; }
  ['myName', 'myBizno', 'email'].forEach(k => { if (k in inp) s[k] = String(inp[k] || '').trim().slice(0, 80); });
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
    closeDt: item.closeDt, price: item.price, kind: item.kind || 'Servc', status: '대기', addedAt: now_() });
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
  rs.forEach((r, i) => { if (r[8] !== 'Y' && (!keys || keys.indexOf(r[1]) >= 0)) sh.getRange(i + 2, 9).setValue('Y'); });
}

// ════════════════════════ 검색 (입찰공고) ════════════════════════

function search_(text, days, kinds) {
  text = String(text || '').trim();
  days = Math.max(1, Math.min(90, days));
  const now = new Date(), map = {};
  const add = r => {
    const n = mapNotice_(r); if (!n.no) return;
    const old = map[n.no];
    if (!old || String(n.ord) > String(old.ord)) map[n.no] = n;   // 같은 공고는 최신 차수만
  };
  kinds.forEach(k => {
    // 기간이 길면 30일씩 나눠 부른다
    for (let end = now; end > now - days * 864e5; end = new Date(end - 30 * 864e5)) {
      const begin = new Date(Math.max(end - 30 * 864e5, now - days * 864e5));
      const base = { inqryDiv: '1', inqryBgnDt: fmt_(begin), inqryEndDt: fmt_(end) };
      if (!text) { bidCall_(k, base, 50, 2).forEach(add); continue; }
      bidCall_(k, Object.assign({ bidNtceNm: text }, base), 50, 4).forEach(add);
      // 기관 이름으로도 찾는다 (예: '국립해양조사원')
      bidCall_(k, Object.assign({ dminsttNm: text }, base), 50, 2).forEach(add);
      bidCall_(k, Object.assign({ ntceInsttNm: text }, base), 50, 2).forEach(add);
    }
  });
  const items = Object.keys(map).map(k => map[k]).sort((a, b) => String(b.postDt).localeCompare(String(a.postDt))).slice(0, 150);
  return { items: items, total: items.length };
}

function mapNotice_(r) {
  return {
    no: String(r.bidNtceNo || '').trim(), ord: String(r.bidNtceOrd || '').trim(), name: r.bidNtceNm || '',
    org: r.ntceInsttNm || '', demand: r.dminsttNm || '', postDt: r.bidNtceDt || '', closeDt: r.bidClseDt || '',
    opengDt: r.opengDt || '', price: Number(r.presmptPrce || r.asignBdgtAmt || 0) || 0, kind: r._kind || 'Servc',
  };
}

/** 입찰공고 PPSSrch 호출 — 새 이름(02) → 옛 이름 순서로 시도하고 되는 쪽을 기억 */
function bidCall_(kind, params, rows, pages) {
  const pref = Number(P.getProperty('bidApi') || 0), order = [pref, 1 - pref];
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const api = BID_APIS[order[i]];
    try {
      const items = fetchAll_(api.base + 'getBidPblancListInfo' + kind + 'PPSSrch' + api.suffix, params, rows, pages);
      if (order[i] !== pref) P.setProperty('bidApi', String(order[i]));
      items.forEach(x => { x._kind = kind; });
      return items;
    } catch (e) { lastErr = e; if (/LIMITED|한도|SERVICE_KEY|등록되지/i.test(String(e.message))) throw e; }
  }
  throw lastErr;
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
    const add = (r, via) => { const k = keyOf_(r); if (!found[k]) { r._via = via; found[k] = r; } };

    // 1) 빠른 감시: 지난 확인 이후 입력된 개찰결과 전체 (10분 겹치게)
    const last = Number(P.getProperty('lastRun') || 0);
    const from = new Date(Math.max(last ? last - 10 * 60e3 : 0, now - 90 * 60e3));
    s.kinds.forEach(k => {
      fetchAll_(SCRS + 'getOpengResultListInfo' + k, { inqryDiv: '1', inqryBgnDt: fmt_(from), inqryEndDt: fmt_(now) }, 50, 6)
        .forEach(r => { const v = via_(r, s, W); if (v) add(r, v); });
    });

    // 2) 안전망: 감시 공고 중 개찰 시각이 지난 것 + 키워드 (30분마다)
    const lastSweep = Number(P.getProperty('lastSweep') || 0);
    if (force || now - lastSweep >= 30 * 60e3) {
      W.filter(w => w.status === '대기' && (!w.opengDt || String(w.opengDt).replace(/\D/g, '').slice(0, 12) <= fmt_(now)))
        .forEach(w => {
          fetchAll_(SCRS + 'getOpengResultListInfo' + (w.kind || 'Servc') + 'PPSSrch', { inqryDiv: '3', bidNtceNo: w.no }, 20, 1)
            .forEach(r => add(r, '감시 공고'));
        });
      const begin = new Date(now - 2 * 864e5);
      s.kinds.forEach(k => s.keywords.forEach(kw => {
        fetchAll_(SCRS + 'getOpengResultListInfo' + k + 'PPSSrch', { inqryDiv: '2', inqryBgnDt: fmt_(begin), inqryEndDt: fmt_(now), bidNtceNm: kw }, 50, 2)
          .forEach(r => { const v = via_(r, s, W); if (v) add(r, v); });
      }));
      P.setProperty('lastSweep', String(now.getTime()));
    }
    P.setProperty('lastRun', String(now.getTime()));
    P.setProperty('lastRunText', Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm'));

    // 3) 처음 보는 결과(같은 공고라도 상태가 바뀌면 새 결과)만 저장·알림
    const seen = {};
    rows_(sheet_('결과')).forEach(r => { seen[r[1] + '|' + r[2]] = 1; });
    let changed = false;
    Object.keys(found).forEach(k => {
      const raw = found[k], status = raw.progrsDivCdNm || '개찰';
      if (seen[k + '|' + status]) return;
      const r = buildResult_(raw, s);
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

/** 왜 알림 대상인지 ('감시 공고' / '키워드 GIS' / '기관 …'), 아니면 '' */
function via_(r, s, W) {
  const norm = x => String(x || '').replace(/\s/g, '').toLowerCase();
  const name = norm(r.bidNtceNm);
  if (W.some(w => w.no === String(r.bidNtceNo).trim())) return '감시 공고';
  if (s.exclude.some(x => name.indexOf(norm(x)) >= 0)) return '';
  const kw = s.keywords.find(x => name.indexOf(norm(x)) >= 0);
  if (kw) return '키워드 ' + kw;
  const inst = norm(r.ntceInsttNm) + '|' + norm(r.dminsttNm);
  const it = s.institutions.find(x => inst.indexOf(norm(x)) >= 0);
  return it ? '기관 ' + it : '';
}

function buildResult_(raw, s) {
  const top = parseTop_(raw.opengCorpInfo);
  const r = {
    key: keyOf_(raw), at: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
    no: String(raw.bidNtceNo).trim(), ord: raw.bidNtceOrd || '', cls: raw.bidClsfcNo || '', rbid: raw.rbidNo || '',
    name: raw.bidNtceNm || '', org: raw.ntceInsttNm || '', demand: raw.dminsttNm || '', opengDt: raw.opengDt || '',
    status: raw.progrsDivCdNm || '개찰', prtcpt: Number(raw.prtcptCnum || 0), via: raw._via || '',
    top: top ? { name: top.name, amount: Number(top.amount) || 0, rate: Number(top.rate) || 0 } : null, mine: null, bidders: [],
  };
  if (r.status === '개찰완료') {
    const all = bidders_(r, s);
    const mine = all.filter(b => b.mine)[0];
    if (mine) r.mine = { rank: mine.rank, amount: mine.amount, rate: mine.rate };
    r.bidders = all.slice(0, 10);
    if (mine && r.bidders.indexOf(mine) < 0) r.bidders.push(mine);
  }
  return r;
}

/** 업체별 개찰순위 */
function bidders_(r, s) {
  try {
    const p = { bidNtceNo: r.no };
    if (r.ord) p.bidNtceOrd = r.ord;
    const biz = String(s.myBizno || '').replace(/\D/g, ''), nm = String(s.myName || '').replace(/\s/g, '');
    return fetchAll_(SCRS + 'getOpengResultListInfoOpengCompt', p, 100, 3)
      .filter(b => (!r.cls || !b.bidClsfcNo || b.bidClsfcNo === r.cls) && (!r.rbid || !b.rbidNo || b.rbidNo === r.rbid))
      .map(b => ({
        rank: Number(b.opengRank) || 0, name: b.prcbdrNm || '', amount: Number(b.bidprcAmt) || 0, rate: Number(b.bidprcrt) || 0,
        rmrk: String(b.rmrk || '').trim(),
        mine: (biz && String(b.prcbdrBizno || '').replace(/\D/g, '') === biz) || (!!nm && String(b.prcbdrNm || '').replace(/\s/g, '').indexOf(nm) >= 0),
      }))
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
  const subject = '[' + r.status + '] ' + r.name
    + (r.top ? ' — 1순위 ' + r.top.name + ' (' + rate_(r.top.rate) + ')' : '')
    + (r.mine ? ' / 우리 ' + (r.mine.rank || '-') + '위' : '');
  const lines = [
    '공고번호: ' + r.no + '-' + (r.ord || '000') + ' · ' + r.via,
    '기관: ' + r.org + (r.demand && r.demand !== r.org ? ' / ' + r.demand : ''),
    '개찰: ' + r.opengDt + ' · 참가 ' + r.prtcpt + '개사',
  ];
  if (r.top) lines.push('1순위: ' + r.top.name + ' ' + won_(r.top.amount) + ' (' + rate_(r.top.rate) + ')');
  if (r.mine) lines.push('우리 회사: ' + (r.mine.rank || '순위없음') + '위 ' + won_(r.mine.amount) + ' (' + rate_(r.mine.rate) + ')');

  if (s.mail) {
    const table = r.bidders.length ? '<table cellpadding="5" style="border-collapse:collapse;font-size:13px">'
      + '<tr style="background:#e9f2fa"><th>순위</th><th align="left">업체</th><th align="right">투찰금액</th><th align="right">투찰률</th></tr>'
      + r.bidders.map(b => '<tr style="border-top:1px solid #ddd' + (b.mine ? ';background:#fff4c2;font-weight:bold' : '') + '"><td>' + (b.rank || '-') + '</td><td>'
        + esc_(b.name) + (b.rmrk && b.rmrk !== '정상' ? ' <small>(' + esc_(b.rmrk) + ')</small>' : '') + '</td><td align="right">' + won_(b.amount) + '</td><td align="right">' + rate_(b.rate) + '</td></tr>').join('')
      + '</table>' : '';
    MailApp.sendEmail({
      to: s.email || Session.getEffectiveUser().getEmail(), subject: subject.slice(0, 250),
      body: lines.join('\n') + '\n\n' + APP_URL,
      htmlBody: '<div style="font-family:sans-serif"><h3 style="color:#2b6ca3;margin:0 0 8px">' + esc_(r.name) + '</h3><p>'
        + lines.map(esc_).join('<br>') + '</p>' + table + '<p><a href="' + APP_URL + '">개찰알림 앱에서 보기</a></p></div>',
    });
  }
  if (s.telegram) {
    tg_(subject + '\n\n' + lines.join('\n') + (r.bidders.length ? '\n\n' + r.bidders.slice(0, 5).map(b =>
      (b.rank || '-') + '. ' + b.name + ' ' + rate_(b.rate) + (b.mine ? ' ◀ 우리' : '')).join('\n') : '') + '\n\n' + APP_URL);
  }
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
  return r.getResponseCode() === 200;
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

function call_(url, params) {
  const key = P.getProperty('G2B_KEY');
  if (!key) throw new Error('스크립트 속성 G2B_KEY(공공데이터포털 인증키)가 없어요');
  const q = Object.keys(params).filter(k => params[k] !== '' && params[k] != null).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  const full = url + '?serviceKey=' + (key.indexOf('%') >= 0 ? key : encodeURIComponent(key)) + '&type=json&' + q;
  const ck = 'calls|' + day_();
  P.setProperty(ck, String(Number(P.getProperty(ck) || 0) + 1));
  let res, text;
  for (let i = 0; i < 3; i++) {
    res = UrlFetchApp.fetch(full, { muteHttpExceptions: true });
    text = res.getContentText();
    if (res.getResponseCode() < 500) break;
    Utilities.sleep(1500 * (i + 1));
  }
  if (res.getResponseCode() === 404) throw new Error('없는 주소 (404): ' + url.split('/').pop());
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
  if (!P.getProperty('G2B_KEY')) throw new Error('먼저 프로젝트 설정 → 스크립트 속성에 G2B_KEY(공공데이터포털 인증키)를 넣어 주세요');
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
  const items = fetchAll_(SCRS + 'getOpengResultListInfoServcPPSSrch', { inqryDiv: '2', inqryBgnDt: fmt_(new Date(now - 3 * 864e5)), inqryEndDt: fmt_(now) }, 10, 1);
  const raw = items.filter(x => x.progrsDivCdNm === '개찰완료')[0] || items[0];
  if (!raw) throw new Error('최근 개찰결과가 없어 시험할 수 없어요. 평일 낮에 다시 해 주세요');
  raw._via = '시험';
  const r = buildResult_(raw, s);
  r.name = '[시험] ' + r.name;
  notify_(r, Object.assign({}, s, { mail: s.mail || !s.telegram }));
}

/** 자동 확인 끄기 */
function stop() { ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'check').forEach(t => ScriptApp.deleteTrigger(t)); }
