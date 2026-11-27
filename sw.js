// 서비스 워커 — 네트워크 우선, 실패하면 캐시 (오프라인에서도 앱이 열리게). 외부 API 는 건드리지 않는다.
const CACHE = 'g2b-alert-1795795722';   // scripts/bump_version.py 가 숫자를 바꾼다
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192-v1.png', 'icon-180-v1.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'push-cfg').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 같은 주소의 GET 만 다룬다. version.txt 는 항상 새로 받는다.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('version.txt')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
const PUSH_APP_NAME = '개찰알림', PUSH_ICON = 'icon-192-v1.png';
// ── 휴대폰 푸시 알림 (friese-mobile-webapp-kit · web-push) ──
// 서버가 내용 없는 푸시를 보내면, 앱이 적어 둔 캐시 'push-cfg'(서버 주소·암호)로 문구를 받아 띄운다.
// 실패해도 알림은 반드시 하나 띄운다(아이폰은 안 띄운 푸시가 쌓이면 구독을 끊는다). activate 에서 'push-cfg' 캐시는 지우지 않는다.
self.addEventListener('push', e => e.waitUntil((async () => {
  let m = null;
  try {
    const r0 = await (await caches.open('push-cfg')).match('cfg'); const cfg = r0 ? await r0.json() : null;
    const sub = await self.registration.pushManager.getSubscription();
    if (cfg && cfg.api) {
      const r = await fetch(cfg.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({}, cfg.extra, { action: 'pushMsg', endpoint: sub && sub.endpoint })) });
      const j = await r.json(); m = j && (j.data ? j.data.msg : j.msg);
    }
  } catch (_) {}
  m = m || { title: PUSH_APP_NAME, body: '새 소식이 있어요. 눌러서 확인해 주세요.' };
  await self.registration.showNotification(m.title, { body: m.body, icon: PUSH_ICON, badge: PUSH_ICON });
})()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => ws.length ? ws[0].focus() : self.clients.openWindow('./')));
});
