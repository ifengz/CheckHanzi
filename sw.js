/* 查字宝 Service Worker：朗读音频离线缓存
 * - /api/tts?text=X：缓存优先（命中零网络），未命中回源并写入缓存
 * - /char-dict.html：网络优先（保证更新可达），断网回退缓存
 * 版本号 v1：字典/策略变更时 bump，旧缓存整体废弃
 */
var CACHE = "chazi-tts-v1";

self.addEventListener("install", function(e){ self.skipWaiting(); });
self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(e){
  var url;
  try{ url = new URL(e.request.url); }catch(err){ return; }
  if(e.request.method !== "GET") return;

  if(url.pathname === "/api/tts"){
    e.respondWith(
      caches.open(CACHE).then(function(c){
        return c.match(e.request, {ignoreSearch:false}).then(function(hit){
          if(hit) return hit;
          return fetch(e.request).then(function(resp){
            if(resp && resp.ok){
              try{ c.put(e.request, resp.clone()); }catch(err2){}
            }
            return resp;
          });
        });
      }).catch(function(){ return fetch(e.request); })
    );
    return;
  }

  if(url.pathname === "/char-dict.html" || url.pathname === "./" || url.pathname === "/"){
    e.respondWith(
      fetch(e.request).then(function(resp){
        try{
          var cp = resp.clone();
          caches.open(CACHE).then(function(c){ c.put("/char-dict.html", cp); });
        }catch(err){}
        return resp;
      }).catch(function(){
        return caches.open(CACHE).then(function(c){
          return c.match("/char-dict.html").then(function(hit){ return hit || Response.error(); });
        });
      })
    );
  }
});
