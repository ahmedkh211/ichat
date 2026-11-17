/* iChat — Service Worker */
const VERSION = 'ichat-v1.2.0';
const CACHE = VERSION;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/favicon-48.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-180.png'
];

/* التثبيت: تخزين مسبق — cache:'reload' لتجاوز HTTP cache وضمان محتوى جديد */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(ASSETS.map((u) =>
        fetch(new Request(u, { cache: 'reload' }))
          .then((r) => (r.ok ? c.put(u, r) : Promise.resolve()))
          .catch(() => Promise.resolve())
      ))
    )
  );
});

/* التفعيل: حذف الكاشات القديمة + claim */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* استقبال أمر التخطي من شريط التحديث */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* الجلب: كاش أولًا للطلبات same-origin GET مع الشبكة كاحتياط */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
