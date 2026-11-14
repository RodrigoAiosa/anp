/* Service worker: abre o mapa na hora e funciona sem internet.
 *
 * - Páginas, JS e CSS do próprio site: rede primeiro (com validação 304), cache só offline.
 * - /vendor (Leaflet, fontes): cache primeiro.
 * - O que é de outro domínio (mapa de fundo, cobertura, ViaCEP, Nominatim) NÃO
 *   passa por aqui: o navegador pede direto. Offline abre só a página; os dados vêm da rede.
 * - /status.json e /dados/ nunca são guardados.
 */
const VERSAO = "{{VERSAO}}";
const CACHE = "postos-" + VERSAO;
const BASICOS = ["/", "/sobre", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  // Só a home é obrigatória; os demais são tolerados se falharem (ex.: 404).
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.add("/");
    await Promise.all(BASICOS.slice(1).map((u) => c.add(u).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n.startsWith("postos-") && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/status.json" || url.pathname.startsWith("/dados/") || url.pathname === "/sw.js") return;

  // Páginas, JS e CSS do próprio site: rede primeiro (o deploy novo aparece na hora), cache só se estiver offline.
  // /vendor e fontes (imutáveis): cache primeiro, atualizando em segundo plano.
  const imutavel = url.pathname.startsWith("/vendor/");
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const chave = req.mode === "navigate" && url.pathname === "/" ? "/" : req;
    const guardado = await cache.match(chave, { ignoreSearch: true });
    const rede = fetch(req, imutavel ? undefined : { cache: "no-cache" }).then((resp) => {
      if (resp && resp.ok) cache.put(chave, resp.clone());
      return resp;
    });
    if (imutavel && guardado) { rede.catch(() => {}); return guardado; }
    try { return await rede; }
    catch (err) {
      if (guardado) return guardado;
      if (req.mode === "navigate") { const home = await cache.match("/"); if (home) return home; }
      return new Response("Sem conexão.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  })());
});
