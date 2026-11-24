const CACHE='focus-reader-v6-cloud-1';
const appFiles=[
  'index.html',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs'
];
const scope=self.registration.scope;
const appUrls=new Set(appFiles.map(file=>new URL(file,scope).href));
const indexUrl=new URL('index.html',scope).href;

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll([...appUrls].map(url=>new Request(url,{cache:'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith('focus-reader-')&&key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  url.search='';
  const cacheUrl=event.request.mode==='navigate'&&url.href===scope?indexUrl:url.href;
  if(!appUrls.has(cacheUrl))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    return (await cache.match(cacheUrl))||fetch(event.request);
  })());
});
