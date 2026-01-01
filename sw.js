const CACHE_NAME = 'pandawa-cache-v2';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // CDN Eksternal (Supaya tampilan tidak rusak saat offline/lemot)
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://unpkg.com/html5-qrcode',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js'
];

// 1. Install Service Worker & Cache Aset Utama
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        // Gunakan addAll dengan catch agar jika satu CDN gagal, SW tetap terinstall
        return Promise.all(
          urlsToCache.map(url => {
            return cache.add(url).catch(err => {
              console.warn('Gagal cache file:', url, err);
            });
          })
        );
      })
  );
  self.skipWaiting();
});

// 2. Activate & Hapus Cache Lama (Penting untuk Update)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Menghapus cache lama:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. Fetch Strategy: Network First, Fallback to Cache
// (Coba internet dulu, kalau mati baru ambil cache)
self.addEventListener('fetch', event => {
  // Abaikan request selain GET (seperti POST transaksi ke API)
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Jika berhasil ambil dari internet, simpan copy-nya ke cache
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        
        // Clone response karena stream hanya bisa dibaca sekali
        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(event.request, responseToCache);
          });
          
        return response;
      })
      .catch(() => {
        // Jika internet mati (Offline), ambil dari cache
        return caches.match(event.request)
            .then(cachedResponse => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                // Jika tidak ada di cache (misal gambar baru), kembalikan kosong/error
                return null; 
            });
      })
  );
});