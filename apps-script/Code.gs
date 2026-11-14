/**
 * 나라장터 개찰결과 실시간 알림 (Google Apps Script)
 *
 * 동작
 *  1) 빠른 감시: 1~2분마다 "방금 입력된 개찰결과"(입력일시 기준)를 한 번에 받아
 *     내 조건(공고번호·키워드·기관)에 맞는 것만 골라 즉시 알림
 *  2) 안전망: 30분마다 공고번호·키워드로 직접 다시 조회해서 놓친 건 보충
 *  3) 맞는 건이 나오면 업체별 순위(상위 10개 + 우리 회사 순위)까지 조회해서
 *     Gmail(기본)과 텔레그램(선택)으로 보냄. 같은 결과는 한 번만 알림.
 *
 * 처음 설정은 README.md 참고:
 *  - 스크립트 속성 G2B_KEY 에 공공데이터포털 서비스키(디코딩 키) 저장
 *  - 아래 CONFIG 수정 → testApi() → testNotify() → setup() 순서로 실행
 */

// ===================== 여기만 고치면 됩니다 =====================
const CONFIG = {
  // 감시할 입찰공고번호 (예: 'R25BK01250632'). 차수는 신경 안 써도 됨
  BID_NOS: [],

  // 공고명에 이 단어가 하나라도 들어가면 알림 (띄어쓰기 무시, 대소문자 무시)
  KEYWORDS: ['GIS', '공간정보', '지리정보', '해양', '연안', '수치지도', '디지털트윈'],

  // 공고명에 이 단어가 들어가면 제외
  EXCLUDE: [],

  // 공고기관·수요기관 이름에 이 단어가 들어가면 알림 (예: '해양수산부', '해양경찰청')
  INSTITUTIONS: [],

  // 업무구분: 'Servc'(용역) 'Thng'(물품) 'Cnstwk'(공사) 'Frgcpt'(외자)
  KINDS: ['Servc'],

  // 우리 회사 (업체별 순위에서 강조 표시). 사업자번호는 숫자만, 모르면 '' 그대로
  MY_COMPANY_NAME: '올포랜드',
  MY_COMPANY_BIZNO: '',

  // 알림 받을 메일 (비우면 스크립트 소유자 Gmail)
  EMAIL: '',

  // 감시 시간대 (한국시간). 개찰은 평일 낮에 몰려 있어서 호출 수를 아낍니다
  WEEKDAYS_ONLY: true,
  START_HOUR: 8,
  END_HOUR: 20,

  // 실행 간격(분): 1, 5, 10, 15, 30 중 하나. setup() 다시 실행해야 반영
  TRIGGER_MINUTES: 1,

  // 안전망(공고번호·키워드 직접 조회) 간격(분)
  SWEEP_MINUTES: 30,
};
// ================================================================

const BASE = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService/';
const TZ = 'Asia/Seoul';
const PROPS = PropertiesService.getScriptProperties();

/** 트리거가 주기적으로 부르는 함수 */
function check() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 이전 실행이 아직 도는 중
  try {
    const now = new Date();
    if (!inActiveHours_(now)) return;

    const found = {};
    const add = (r) => { if (matches_(r)) found[keyOf_(r)] = r; };

    // 1) 빠른 감시: 지난 실행 이후 입력된 개찰결과 전체 (10분 겹치게 조회)
    const last = Number(PROPS.getProperty('lastRun') || 0);
    const from = new Date(Math.max(last ? last - 10 * 60e3 : 0, now - 60 * 60e3));
    CONFIG.KINDS.forEach((k) => {
      fetchAll_('getOpengResultListInfo' + k, {
        inqryDiv: '1', inqryBgnDt: fmt_(from), inqryEndDt: fmt_(now),
      }).forEach(add);
    });
    PROPS.setProperty('lastRun', String(now.getTime()));

    // 2) 안전망: 공고번호·키워드로 직접 조회
    const lastSweep = Number(PROPS.getProperty('lastSweep') || 0);
    if (now - lastSweep >= CONFIG.SWEEP_MINUTES * 60e3) {
      sweep_(now).forEach(add);
      PROPS.setProperty('lastSweep', String(now.getTime()));
    }

    // 3) 새로 나온 결과만 알림
    const seen = loadSeen_();
    Object.keys(found).forEach((key) => {
      const r = found[key];
      const seenKey = key + '|' + (r.progrsDivCdNm || '');
      if (seen[seenKey]) return;
      notify_(r, fetchBidders_(r));
      seen[seenKey] = now.getTime();
    });
    saveSeen_(seen, now);
  } catch (e) {
    reportError_(e);
  } finally {
    lock.releaseLock();
  }
}

function sweep_(now) {
  const out = [];
  const from = new Date(now - 2 * 24 * 3600e3); // 최근 2일 개찰분
  CONFIG.KINDS.forEach((k) => {
    const op = 'getOpengResultListInfo' + k + 'PPSSrch';
    CONFIG.BID_NOS.forEach((no) => {
      fetchAll_(op, { inqryDiv: '3', bidNtceNo: String(no).trim() }).forEach((r) => out.push(r));
    });
    CONFIG.KEYWORDS.forEach((kw) => {
      fetchAll_(op, {
        inqryDiv: '2', inqryBgnDt: fmt_(from), inqryEndDt: fmt_(now), bidNtceNm: kw,
      }).forEach((r) => out.push(r));
    });
  });
  return out;
}

/** 내 조건에 맞는 개찰결과인지 */
function matches_(r) {
  const norm = (s) => String(s || '').replace(/\s/g, '').toLowerCase();
  const name = norm(r.bidNtceNm);
  if (CONFIG.EXCLUDE.some((w) => name.indexOf(norm(w)) >= 0)) return false;
  if (CONFIG.BID_NOS.some((no) => String(no).trim() === String(r.bidNtceNo).trim())) return true;
  if (CONFIG.KEYWORDS.some((w) => name.indexOf(norm(w)) >= 0)) return true;
  const inst = norm(r.ntceInsttNm) + '|' + norm(r.dminsttNm);
  return CONFIG.INSTITUTIONS.some((w) => inst.indexOf(norm(w)) >= 0);
}

/** 업체별 개찰순위 (개찰완료일 때만 나옴) */
function fetchBidders_(r) {
  try {
    const params = { bidNtceNo: r.bidNtceNo };
    if (r.bidNtceOrd) params.bidNtceOrd = r.bidNtceOrd;
    return fetchAll_('getOpengResultListInfoOpengCompt', params, 100, 3)
      .filter((b) => (!r.bidClsfcNo || !b.bidClsfcNo || b.bidClsfcNo === r.bidClsfcNo)
        && (!r.rbidNo || !b.rbidNo || b.rbidNo === r.rbidNo))
      .sort((a, b) => (Number(a.opengRank) || 1e9) - (Number(b.opengRank) || 1e9));
  } catch (e) {
    console.warn('업체별 순위 조회 실패: ' + e);
    return [];
  }
}

// ----------------------------- 알림 -----------------------------

function notify_(r, bidders) {
  const top = parseTop_(r.opengCorpInfo);
  const mine = bidders.find(isMine_);
  const status = r.progrsDivCdNm || '개찰';
  const subject = '[' + status + '] ' + r.bidNtceNm
    + (top ? ' — 1순위 ' + top.name + ' (' + top.rate + '%)' : '')
    + (mine ? ' / 우리 ' + (Number(mine.opengRank) || '-') + '위' : '');

  const lines = [
    '공고번호: ' + r.bidNtceNo + '-' + (r.bidNtceOrd || '000'),
    '공고기관: ' + (r.ntceInsttNm || '') + ' / 수요기관: ' + (r.dminsttNm || ''),
    '개찰일시: ' + (r.opengDt || '') + ' / 참가업체: ' + (r.prtcptCnum || '?') + '개',
    '진행상태: ' + status,
  ];
  if (top) lines.push('1순위: ' + top.name + ' ' + won_(top.amount) + ' (' + top.rate + '%)');
  if (mine) lines.push('우리 회사: ' + (Number(mine.opengRank) || '순위없음') + '위 '
    + won_(mine.bidprcAmt) + ' (' + mine.bidprcrt + '%) ' + (mine.rmrk || ''));

  const rows = bidders.slice(0, 10);
  if (mine && rows.indexOf(mine) < 0) rows.push(mine);
  const table = rows.length ? '<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:13px">'
    + '<tr><th>순위</th><th>업체</th><th>투찰금액</th><th>투찰률</th><th>비고</th></tr>'
    + rows.map((b) => '<tr' + (isMine_(b) ? ' style="background:#fff3b0;font-weight:bold"' : '') + '>'
      + '<td>' + (Number(b.opengRank) || '-') + '</td><td>' + esc_(b.prcbdrNm) + '</td>'
      + '<td align="right">' + won_(b.bidprcAmt) + '</td><td>' + esc_(b.bidprcrt) + '%</td>'
      + '<td>' + esc_(b.rmrk) + '</td></tr>').join('')
    + '</table>' : '';
  const link = 'https://www.g2b.go.kr';

  MailApp.sendEmail({
    to: CONFIG.EMAIL || Session.getEffectiveUser().getEmail(),
    subject: subject.slice(0, 250),
    body: lines.join('\n') + '\n\n' + link,
    htmlBody: '<p>' + lines.map(esc_).join('<br>') + '</p>' + table
      + '<p style="color:#888">전체 결과: 나라장터(' + link + ') → 개찰결과에서 공고번호 '
      + esc_(r.bidNtceNo) + ' 검색</p>',
  });

  sendTelegram_(subject + '\n\n' + lines.join('\n') + '\n\n'
    + rows.slice(0, 5).map((b) => (Number(b.opengRank) || '-') + '. ' + b.prcbdrNm + ' '
      + b.bidprcrt + '%' + (isMine_(b) ? ' ◀ 우리' : '')).join('\n'));
}

/** 선택: 스크립트 속성 TG_TOKEN, TG_CHAT_ID 가 있으면 텔레그램으로도 보냄 */
function sendTelegram_(text) {
  const token = PROPS.getProperty('TG_TOKEN');
  const chat = PROPS.getProperty('TG_CHAT_ID');
  if (!token || !chat) return;
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', muteHttpExceptions: true,
    payload: { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: 'true' },
  });
}

/** 같은 오류는 하루 한 번만 메일로 알림 */
function reportError_(e) {
  console.error(e);
  const msg = String(e && e.message || e);
  const day = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  const key = 'err|' + day + '|' + msg.slice(0, 60);
  if (PROPS.getProperty('lastErr') === key) return;
  PROPS.setProperty('lastErr', key);
  MailApp.sendEmail(CONFIG.EMAIL || Session.getEffectiveUser().getEmail(),
    '[개찰알림 오류] ' + msg.slice(0, 100), msg + '\n\n' + (e && e.stack || ''));
}

// ----------------------------- API -----------------------------

function fetchAll_(op, params, rows, maxPages) {
  rows = rows || 50;
  maxPages = maxPages || 5;
  let out = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = call_(op, Object.assign({ numOfRows: rows, pageNo: page }, params));
    const items = Array.isArray(body.items) ? body.items
      : (body.items && body.items.item) ? [].concat(body.items.item) : [];
    out = out.concat(items);
    if (items.length < rows || out.length >= Number(body.totalCount || 0)) break;
  }
  return out;
}

function call_(op, params) {
  const key = PROPS.getProperty('G2B_KEY');
  if (!key) throw new Error('스크립트 속성 G2B_KEY(공공데이터포털 서비스키)가 없습니다.');
  const q = Object.keys(params).filter((k) => params[k] !== '' && params[k] != null)
    .map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
  const url = BASE + op + '?serviceKey=' + (key.indexOf('%') >= 0 ? key : encodeURIComponent(key))
    + '&type=json&' + q;

  let res, text;
  for (let i = 0; i < 3; i++) {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    text = res.getContentText();
    if (res.getResponseCode() < 500) break;
    Utilities.sleep(1500 * (i + 1));
  }
  if (text.trim().charAt(0) === '<') { // 키 오류·호출한도 초과 시 XML로 옴
    const m = text.match(/<returnAuthMsg>([^<]*)</) || text.match(/<errMsg>([^<]*)</);
    throw new Error(op + ' 호출 실패: ' + (m ? m[1] : text.slice(0, 200)));
  }
  const json = JSON.parse(text);
  const h = (json.response && json.response.header) || {};
  if (h.resultCode && h.resultCode !== '00') throw new Error(op + ' 오류 ' + h.resultCode + ' ' + h.resultMsg);
  return (json.response && json.response.body) || {};
}

// ----------------------------- 도우미 -----------------------------

function keyOf_(r) {
  return [r.bidNtceNo, r.bidNtceOrd || '', r.bidClsfcNo || '', r.rbidNo || ''].join('|');
}

function parseTop_(s) {
  if (!s) return null;
  const p = String(s).split('^');
  return { name: p[0] || '', bizno: p[1] || '', ceo: p[2] || '', amount: p[3] || '', rate: p[4] || '' };
}

function isMine_(b) {
  const biz = String(CONFIG.MY_COMPANY_BIZNO || '').replace(/\D/g, '');
  if (biz && String(b.prcbdrBizno || '').replace(/\D/g, '') === biz) return true;
  return !!CONFIG.MY_COMPANY_NAME
    && String(b.prcbdrNm || '').replace(/\s/g, '').indexOf(CONFIG.MY_COMPANY_NAME.replace(/\s/g, '')) >= 0;
}

function inActiveHours_(d) {
  const day = Number(Utilities.formatDate(d, TZ, 'u')); // 1=월 … 7=일
  const hour = Number(Utilities.formatDate(d, TZ, 'H'));
  if (CONFIG.WEEKDAYS_ONLY && day >= 6) return false;
  return hour >= CONFIG.START_HOUR && hour < CONFIG.END_HOUR;
}

function loadSeen_() {
  try { return JSON.parse(PROPS.getProperty('seen') || '{}'); } catch (e) { return {}; }
}

function saveSeen_(seen, now) {
  const keep = {};
  Object.keys(seen).filter((k) => now - seen[k] < 7 * 24 * 3600e3)
    .sort((a, b) => seen[b] - seen[a]).slice(0, 120)
    .forEach((k) => { keep[k] = seen[k]; });
  PROPS.setProperty('seen', JSON.stringify(keep));
}

function fmt_(d) { return Utilities.formatDate(d, TZ, 'yyyyMMddHHmm'); }
function won_(v) { const n = Number(v); return isFinite(n) && v !== '' ? n.toLocaleString('ko-KR') + '원' : (v || ''); }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ----------------------- 직접 실행하는 함수들 -----------------------

/** ① API 키 확인: 오늘 개찰된 용역 결과 몇 건을 로그에 찍음 */
function testApi() {
  const now = new Date();
  const from = new Date(now - 24 * 3600e3);
  const items = fetchAll_('getOpengResultListInfo' + CONFIG.KINDS[0] + 'PPSSrch',
    { inqryDiv: '2', inqryBgnDt: fmt_(from), inqryEndDt: fmt_(now) }, 10, 1);
  console.log('최근 24시간 개찰결과 ' + items.length + '건 (첫 페이지)');
  items.forEach((r) => console.log([r.opengDt, r.progrsDivCdNm, r.bidNtceNo, r.bidNtceNm,
    (parseTop_(r.opengCorpInfo) || {}).name, matches_(r) ? '◀ 조건일치' : ''].join(' | ')));
}

/** ② 알림 확인: 최근 24시간 개찰결과 중 1건으로 시험 알림을 보냄 */
function testNotify() {
  const now = new Date();
  const items = fetchAll_('getOpengResultListInfo' + CONFIG.KINDS[0] + 'PPSSrch',
    { inqryDiv: '2', inqryBgnDt: fmt_(new Date(now - 24 * 3600e3)), inqryEndDt: fmt_(now) }, 10, 1);
  const r = items.find((x) => x.progrsDivCdNm === '개찰완료') || items[0];
  if (!r) throw new Error('최근 24시간 개찰결과가 없습니다. 평일 낮에 다시 해 보세요.');
  r.bidNtceNm = '[시험] ' + r.bidNtceNm;
  notify_(r, fetchBidders_(r));
  console.log('시험 알림 보냄: ' + r.bidNtceNm);
}

/** ③ 자동 실행 켜기 (다시 실행하면 간격만 바뀜) */
function setup() {
  stop();
  ScriptApp.newTrigger('check').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  PROPS.setProperty('lastRun', String(Date.now()));
  console.log(CONFIG.TRIGGER_MINUTES + '분마다 감시를 시작합니다.');
}

/** 자동 실행 끄기 */
function stop() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'check')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/** 특정 공고번호의 현재 개찰결과를 바로 확인 (편집기에서 공고번호 바꿔서 실행) */
function lookup(bidNo) {
  bidNo = bidNo || CONFIG.BID_NOS[0];
  if (!bidNo) throw new Error('CONFIG.BID_NOS에 공고번호를 넣거나 lookup("공고번호")로 실행하세요.');
  CONFIG.KINDS.forEach((k) => {
    fetchAll_('getOpengResultListInfo' + k + 'PPSSrch', { inqryDiv: '3', bidNtceNo: bidNo }).forEach((r) => {
      console.log(JSON.stringify(r));
      fetchBidders_(r).slice(0, 10).forEach((b) =>
        console.log(b.opengRank + '. ' + b.prcbdrNm + ' ' + b.bidprcAmt + ' ' + b.bidprcrt + '% ' + (b.rmrk || '')));
    });
  });
}
