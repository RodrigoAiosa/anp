"use strict";
/* Mapa de Postos de Combustíveis — ANP.
 * Interface no estilo do MapaAntenasAnatel. Dados: dados/resumo.json (todos os municípios,
 * preço médio por combustível) e dados/uf/<UF>.json (postos, carregado sob demanda).
 */
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var fmtN = function (n) { return Number(n).toLocaleString("pt-BR"); };
  var ehGLP = function (p) { return /^GLP/.test(p || ""); };
  var fmtPreco = function (v, prod) {
    return "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (ehGLP(prod) ? "" : "/L");
  };
  var fmtData = function (d) { return d ? String(d).split("-").reverse().join("/") : ""; };
  var fmtCnpj = function (c) {
    return c && c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : (c || "");
  };
  var norm = function (s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); };
  var PAGINA = 80;
  var MENOS_MOVIMENTO = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var R = null;             // resumo.json
  var idxPosto = {};        // cnpj -> {m, p, uf}
  var cacheUF = {};         // uf -> json
  var mapa, camada, camadaBase, rendCanvas;
  var circulos = {};        // ibge -> L.circleMarker
  var estado = { uf: "", ibge: "", prod: "", cor: "preco", base: "mapa", tema: "escuro", busca: "", mostrar: PAGINA };

  // ------------------------------------------------------------------ tema
  function lerTema() { try { var t = localStorage.getItem("anp-tema"); return t === "claro" || t === "escuro" ? t : null; } catch (e) { return null; } }
  function aplicarTema(t) {
    estado.tema = t;
    document.documentElement.dataset.tema = t;
    try { localStorage.setItem("anp-tema", t); } catch (e) { /* sem armazenamento */ }
  }

  // ------------------------------------------------------------------ mapa
  var COM_ENDERECO = /^https?:$/.test(location.protocol);
  var SERVIDOR = COM_ENDERECO
    ? { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", credito: "&copy; OpenStreetMap" }
    : { url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png", subdominios: "abc", credito: "&copy; OpenStreetMap/ODbL &middot; OSM France" };
  var BASES = { mapa: { nome: "Mapa", classe: "tile-base tile-limpo" }, ruas: { nome: "Ruas", classe: "tile-base" } };

  function aplicarBase() {
    var def = BASES[estado.base] || BASES.mapa;
    var o = { maxZoom: 19, className: def.classe, attribution: SERVIDOR.credito + " &middot; Postos: ANP" };
    if (SERVIDOR.subdominios) o.subdomains = SERVIDOR.subdominios;
    if (camadaBase) mapa.removeLayer(camadaBase);
    camadaBase = L.tileLayer(SERVIDOR.url, o).addTo(mapa);
    camadaBase.bringToBack();
    $$("[data-base]").forEach(function (b) {
      var a = b.dataset.base === estado.base;
      b.classList.toggle("ativo", a);
      b.setAttribute("aria-pressed", a ? "true" : "false");
    });
  }

  function iniciarMapa() {
    rendCanvas = L.canvas({ padding: 0.1 });
    mapa = L.map("mapa", { zoomControl: true, preferCanvas: true, zoomSnap: 0.5, zoomAnimation: !MENOS_MOVIMENTO, worldCopyJump: false })
      .setView([-14.2, -51.9], 4);
    $("#seletor-base").innerHTML = Object.keys(BASES).map(function (k) {
      return '<button type="button" class="chip-botao" data-base="' + k + '">' + BASES[k].nome + "</button>";
    }).join("");
    $$("[data-base]").forEach(function (b) {
      b.addEventListener("click", function () { estado.base = b.dataset.base; aplicarBase(); });
    });
    aplicarBase();
    camada = L.layerGroup().addTo(mapa);
    mapa.on("zoomend", function () { $("#hud-zoom").textContent = "z " + mapa.getZoom().toFixed(1).replace(".0", ""); });
  }

  // -------------------------------------------------------------- cores
  function corPostos(n) { return n >= 200 ? "#e05050" : n >= 50 ? "#F5B400" : n >= 10 ? "#26d7e8" : "#1687ff"; }
  function corPreco(v, esc_) {
    var t = esc_.max > esc_.min ? (v - esc_.min) / (esc_.max - esc_.min) : 0.5;
    t = Math.max(0, Math.min(1, t));
    return "hsl(" + Math.round(135 * (1 - t)) + " " + (65 + 10 * t) + "% " + (45 + 7 * (0.5 - Math.abs(t - 0.5))) + "%)";
  }
  function raio(n) { return Math.max(3.5, Math.min(24, 2.4 * Math.sqrt(n))); }

  function visiveis() {
    return R.municipios.filter(function (m) { return !estado.uf || m[2] === estado.uf; });
  }
  function escalaPreco() {
    var v = [];
    visiveis().forEach(function (m) { var p = m[6] && m[6][estado.prod]; if (p) v.push(p[0]); });
    if (!v.length) return null;
    v.sort(function (a, b) { return a - b; });
    var q = function (f) { return v[Math.min(v.length - 1, Math.floor(f * (v.length - 1)))]; };
    var lo = q(0.05), hi = q(0.95);
    return { min: lo, max: hi > lo ? hi : lo + 0.01, n: v.length };
  }

  function desenharBolhas() {
    camada.clearLayers();
    circulos = {};
    var esc_ = estado.cor === "preco" ? escalaPreco() : null;
    var lista = visiveis().slice().sort(function (a, b) { return b[5] - a[5]; });
    lista.forEach(function (m) {
      var ibge = m[0], nome = m[1], uf = m[2], n = m[5], pr = m[6] && m[6][estado.prod];
      var cor, op = 0.62;
      if (estado.cor === "preco") {
        if (pr && esc_) cor = corPreco(pr[0], esc_); else { cor = "#64748b"; op = 0.3; }
      } else cor = corPostos(n);
      var c = L.circleMarker([m[3], m[4]], { renderer: rendCanvas, radius: raio(n), color: cor, weight: 1.2, fillColor: cor, fillOpacity: op });
      c.bindTooltip(
        "<b>" + esc(nome) + " – " + esc(uf) + "</b><br>" + fmtN(n) + " posto" + (n === 1 ? "" : "s") +
        (pr ? "<br>" + esc(estado.prod) + ": " + fmtPreco(pr[0], estado.prod) + " (média de " + pr[1] + ")" : "<br><span style='opacity:.7'>sem preço de " + esc(estado.prod) + "</span>"),
        { sticky: true, direction: "top", opacity: 1 });
      c.on("click", function () { selecionar(uf, ibge); });
      c.addTo(camada);
      circulos[ibge] = c;
    });
    marcarSelecionado();
    $("#contador").textContent = fmtN(lista.length) + " municípios · " + fmtN(lista.reduce(function (s, m) { return s + m[5]; }, 0)) + " postos";
  }

  function marcarSelecionado() {
    Object.keys(circulos).forEach(function (k) {
      var sel = k === estado.ibge;
      circulos[k].setStyle({ weight: sel ? 3 : 1.2, color: sel ? "#26d7e8" : circulos[k].options.fillColor });
      if (sel) circulos[k].bringToFront();
    });
  }

  function enquadrarBolhas() {
    var pts = R.municipios.filter(function (m) {
      return estado.ibge ? m[0] === estado.ibge : (!estado.uf || m[2] === estado.uf);
    }).map(function (m) { return [m[3], m[4]]; });
    if (!pts.length) return;
    var anim = !MENOS_MOVIMENTO;
    if (pts.length === 1) mapa.flyTo(pts[0], 11, { animate: anim, duration: 0.8 });
    else mapa.flyToBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 9, animate: anim, duration: 0.8 });
  }


  // ----------------------------------------------------- pontos (cada posto, como as ERBs)
  var modoPontos = false;
  var PT = null;                       // dados/pontos.json já em typed arrays
  var camadaPts = null;
  var BAND_CORES = ["#1687ff", "#F5B400", "#e05050", "#2db86a", "#a78bfa", "#26d7e8", "#e08c00"];
  var COR_OUTRAS = "#94a3b8", COR_SEM_PRECO = "#64748b";
  var NBUCKET = 12;
  var bucketCores = (function () {
    var a = [];
    for (var i = 0; i < NBUCKET; i++) { var t = i / (NBUCKET - 1); a.push("hsl(" + Math.round(135 * (1 - t)) + " " + (65 + 10 * t) + "% 50%)"); }
    return a;
  })();
  var filtro = { idx: null, escala: null, ocultas: {} };   // idx: Int32Array dos pontos visíveis (por UF/município/bandeira)
  var selPt = null;                                        // índice do posto selecionado

  function prepararPontos(d) {
    var n = d.lat.length;
    PT = { n: n, uf: d.uf, band: d.band, prod: d.prod, c: d.c, nome: d.n, m: d.m,
      lat: new Float32Array(n), lon: new Float32Array(n), xm: new Float32Array(n), ym: new Float32Array(n),
      u: Int16Array.from(d.u), b: Int16Array.from(d.b), e: Uint8Array.from(d.e),
      preco: new Float32Array(n * Math.max(1, d.prod.length)).fill(NaN), cnpjIdx: {} };
    for (var i = 0; i < n; i++) {
      var la = d.lat[i] / 1e5, lo = d.lon[i] / 1e5;
      PT.lat[i] = la; PT.lon[i] = lo;
      PT.xm[i] = (lo + 180) / 360;
      var sn = Math.sin(la * Math.PI / 180);
      PT.ym[i] = 0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI);
      PT.cnpjIdx[d.c[i]] = i;
    }
    (d.p || []).forEach(function (t) { PT.preco[t[0] * d.prod.length + t[1]] = t[2] / 100; });
  }

  function bandIdxCor(b) { return b < BAND_CORES.length ? BAND_CORES[b] : COR_OUTRAS; }
  function bandGrupo(b) { return b < BAND_CORES.length ? b : BAND_CORES.length; }   // 0..6 e 7 = outras

  function refazerFiltro() {
    var ufIdx = estado.uf ? PT.uf.indexOf(estado.uf) : -1;
    var out = [];
    for (var i = 0; i < PT.n; i++) {
      if (ufIdx >= 0 && PT.u[i] !== ufIdx) continue;
      if (estado.ibge && PT.m[i] !== estado.ibge) continue;
      if (filtro.ocultas[bandGrupo(PT.b[i])]) continue;
      out.push(i);
    }
    filtro.idx = Int32Array.from(out);
    // escala de preço: percentis 5-95 do que está filtrado
    var pi = PT.prod.indexOf(estado.prod), v = [];
    if (pi >= 0) for (var k = 0; k < filtro.idx.length; k++) { var x = PT.preco[filtro.idx[k] * PT.prod.length + pi]; if (x === x) v.push(x); }
    if (v.length) {
      v.sort(function (a, b) { return a - b; });
      var q = function (f) { return v[Math.min(v.length - 1, Math.floor(f * (v.length - 1)))]; };
      var lo = q(0.05), hi = q(0.95);
      filtro.escala = { min: lo, max: hi > lo ? hi : lo + 0.01, n: v.length };
    } else filtro.escala = null;
  }

  function legendaPrecoPontos() {
    var e = filtro.escala;
    return e
      ? '<div class="gradiente" aria-hidden="true"></div><div class="gradiente-rotulos"><span>' + fmtPreco(e.min, estado.prod) + "</span><span>" + fmtPreco(e.max, estado.prod) + "</span></div>" +
        '<div class="nota" style="margin-top:6px">Preço coletado de cada posto (percentis 5 a 95 do recorte). Cinza: posto sem preço de ' + esc(estado.prod) + " na amostra da ANP.</div>"
      : '<div class="nota">Sem preço coletado de ' + esc(estado.prod || "nenhum combustível") + " neste recorte.</div>";
  }

  var CamadaPontos = L.Layer.extend({
    onAdd: function (map) {
      this._map = map;
      this._c = L.DomUtil.create("canvas", "camada-antenas leaflet-zoom-hide");
      this._c.style.position = "absolute";
      this.getPane("overlayPane").appendChild(this._c);
      map.on("moveend resize", this.redesenhar, this);
      map.on("zoomstart", function () { this._c.classList.add("em-zoom"); }, this);
      map.on("zoomend", function () { this._c.classList.remove("em-zoom"); }, this);
      this.redesenhar();
    },
    onRemove: function (map) {
      map.off("moveend resize", this.redesenhar, this);
      L.DomUtil.remove(this._c);
    },
    redesenhar: function () {
      var map = this._map; if (!map || !filtro.idx) return;
      var pad = 0.1, sz = map.getSize(), W = Math.ceil(sz.x * (1 + 2 * pad)), H = Math.ceil(sz.y * (1 + 2 * pad));
      var tl = map.containerPointToLayerPoint([-sz.x * pad, -sz.y * pad]);
      var dpr = Math.min(window.devicePixelRatio || 1, 2), c = this._c;
      c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px";
      L.DomUtil.setPosition(c, tl);
      var ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      var z = map.getZoom(), esc_ = 256 * Math.pow(2, z), o = map.getPixelOrigin();
      var r = z < 5 ? 1.3 : z < 7 ? 1.8 : z < 9 ? 2.4 : z < 11 ? 3.2 : z < 13 ? 4.5 : 6;
      var idx = filtro.idx, pi = PT.prod.indexOf(estado.prod), np = Math.max(1, PT.prod.length);
      var porPreco = estado.cor === "preco", e = filtro.escala;
      var buckets = [], vis = [], vx = [], vy = [];
      var nBk = porPreco ? NBUCKET + 1 : BAND_CORES.length + 1;
      for (var k = 0; k < nBk; k++) buckets.push([]);
      for (var j = 0; j < idx.length; j++) {
        var i = idx[j];
        var x = PT.xm[i] * esc_ - o.x - tl.x, y = PT.ym[i] * esc_ - o.y - tl.y;
        if (x < -8 || y < -8 || x > W + 8 || y > H + 8) continue;
        var bk;
        if (porPreco) {
          var pr = pi >= 0 ? PT.preco[i * np + pi] : NaN;
          bk = pr === pr && e ? Math.max(0, Math.min(NBUCKET - 1, Math.floor((pr - e.min) / (e.max - e.min) * NBUCKET))) : NBUCKET;
        } else bk = bandGrupo(PT.b[i]);
        buckets[bk].push(x, y, i);
      }
      var total = 0;
      for (var b = 0; b < nBk; b++) {
        var arr = buckets[b]; if (!arr.length) continue;
        var cor = porPreco ? (b === NBUCKET ? COR_SEM_PRECO : bucketCores[b]) : (b < BAND_CORES.length ? BAND_CORES[b] : COR_OUTRAS);
        ctx.globalAlpha = porPreco && b === NBUCKET ? 0.5 : 0.85;
        ctx.fillStyle = cor;
        for (var q = 0; q < arr.length; q += 3) {
          var px = arr[q], py = arr[q + 1], ii = arr[q + 2];
          total++;
          vis.push(ii); vx.push(px + tl.x + o.x); vy.push(py + tl.y + o.y);
          if (r < 2) ctx.fillRect(px - r, py - r, r * 2, r * 2);
          else {
            ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832); ctx.fill();
            if (!PT.e[ii]) { ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = porPreco && b === NBUCKET ? 0.5 : 0.85; }
          }
        }
      }
      ctx.globalAlpha = 1;
      this.visiveis = { i: vis, x: vx, y: vy, esc: esc_ };
      var el = $("#contador"); if (el) el.textContent = fmtN(total) + " na tela";
    },
    maisProximo: function (containerPt, tol) {
      var v = this.visiveis, map = this._map; if (!v) return -1;
      var o = map.getPixelOrigin(), mp = map.containerPointToLayerPoint(containerPt);
      var mx = mp.x + o.x, my = mp.y + o.y, melhor = -1, dm = tol * tol;
      for (var k = 0; k < v.i.length; k++) {
        var dx = v.x[k] - mx, dy = v.y[k] - my, d = dx * dx + dy * dy;
        if (d <= dm) { dm = d; melhor = v.i[k]; }
      }
      return melhor;
    },
  });

  function atualizarPontos() {
    refazerFiltro();
    if (camadaPts) camadaPts.redesenhar();
    var nB = {}; // contagem por bandeira (com filtro de UF/município, ignorando o filtro de bandeira)
    renderChipsBandeira();
  }

  function enquadrarPontos() {
    var pts = [], ufIdx = estado.uf ? PT.uf.indexOf(estado.uf) : -1;
    for (var i = 0; i < PT.n; i++) {
      if (ufIdx >= 0 && PT.u[i] !== ufIdx) continue;
      if (estado.ibge && PT.m[i] !== estado.ibge) continue;
      if (PT.e[i] || estado.ibge) pts.push([PT.lat[i], PT.lon[i]]);
    }
    if (!pts.length) return;
    var anim = !MENOS_MOVIMENTO;
    if (pts.length === 1) mapa.flyTo(pts[0], 13, { animate: anim, duration: 0.8 });
    else mapa.flyToBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: estado.ibge ? 13 : 10, animate: anim, duration: 0.8 });
  }

  function renderChipsBandeira() {
    var box = $("#chips-band"); if (!box) return;
    var ufIdx = estado.uf ? PT.uf.indexOf(estado.uf) : -1, cont = {};
    for (var i = 0; i < PT.n; i++) {
      if (ufIdx >= 0 && PT.u[i] !== ufIdx) continue;
      if (estado.ibge && PT.m[i] !== estado.ibge) continue;
      var g = bandGrupo(PT.b[i]); cont[g] = (cont[g] || 0) + 1;
    }
    var h = "";
    for (var g2 = 0; g2 <= BAND_CORES.length; g2++) {
      if (g2 === BAND_CORES.length && !cont[g2]) continue;
      var nome = g2 < BAND_CORES.length ? (PT.band[g2] || "—") : "Outras bandeiras";
      var cor = g2 < BAND_CORES.length ? BAND_CORES[g2] : COR_OUTRAS;
      h += '<label class="chip"><input type="checkbox" data-g="' + g2 + '"' + (filtro.ocultas[g2] ? "" : " checked") + '><span class="bolinha" style="background:' + cor + ';color:' + cor + '"></span><span>' + esc(nome) + ' <span class="n">' + fmtN(cont[g2] || 0) + "</span></span></label>";
    }
    box.innerHTML = h;
    $$("#chips-band input").forEach(function (i) {
      i.addEventListener("change", function () { filtro.ocultas[i.dataset.g] = !i.checked; refazerFiltro(); camadaPts.redesenhar(); renderLegenda(); if (ctxPerto && ctxPerto.modo === "raio") atualizarRaio(false); });
    });
  }

  function ligarInteracaoPontos() {
    var dica = $("#dica"), agendado = false, ult = null;
    function quadro() {
      agendado = false; if (!ult) return;
      var i = camadaPts.maisProximo(ult.containerPoint, 9);
      if (i < 0) { dica.classList.remove("ligada"); mapa.getContainer().style.cursor = ""; return; }
      var pi = PT.prod.indexOf(estado.prod), pr = pi >= 0 ? PT.preco[i * Math.max(1, PT.prod.length) + pi] : NaN;
      dica.innerHTML = '<div class="dica-op"><span class="bolinha" style="background:' + bandIdxCor(PT.b[i]) + '"></span><span>' + esc(PT.nome[i]) + "</span></div>" +
        '<div class="dica-sub">' + esc(PT.band[PT.b[i]]) + " · " + esc(PT.uf[PT.u[i]]) + (PT.e[i] ? "" : " · posição aproximada (centro do município)") + "</div>" +
        (pr === pr ? '<div class="dica-sub">' + esc(estado.prod) + ": <b>" + fmtPreco(pr, estado.prod) + "</b></div>" : "");
      var tam = mapa.getSize(), x = ult.containerPoint.x + 16, y = ult.containerPoint.y + 14;
      if (x + 260 > tam.x) x = ult.containerPoint.x - 16 - dica.offsetWidth;
      if (y + 90 > tam.y) y = ult.containerPoint.y - 14 - dica.offsetHeight;
      dica.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
      dica.classList.add("ligada"); mapa.getContainer().style.cursor = "pointer";
    }
    mapa.on("mousemove", function (e) { ult = e; if (!agendado) { agendado = true; L.Util.requestAnimFrame(quadro); } });
    mapa.on("mouseout movestart zoomstart", function () { dica.classList.remove("ligada"); });
    mapa.on("click", function (e) {
      var i = camadaPts.maisProximo(e.containerPoint, 11);
      if (i < 0) {
        if (ctxPerto && ctxPerto.modo === "raio" && pino) { pino.setLatLng(e.latlng); moverPino(); }
        else procurarRaio({ lat: e.latlng.lat, lon: e.latlng.lng, exato: true, rotulo: "Ponto no mapa · " + e.latlng.lat.toFixed(5) + ", " + e.latlng.lng.toFixed(5) });
        return;
      }
      var uf = PT.uf[PT.u[i]], ibge = PT.m[i], cnpj = PT.c[i];
      if (!ibge) { return; }
      selecionar(uf, ibge, true).then(function () { abrirFichaPosto(cnpj); });
    });
  }

  function ativarPontos() {
    modoPontos = true;
    camada.clearLayers();
    camadaPts = new CamadaPontos(); camadaPts.addTo(mapa);
    ligarInteracaoPontos();
    $("#bloco-band").hidden = false;
    $("#rot-postos").textContent = "Bandeira";
    $("#tit-cor").textContent = "Colorir cada posto pelo:";
    var f = $("#fonte"); if (f) f.innerHTML = "<strong>Dado público</strong> Cadastro e Levantamento de Preços da ANP; posição de cada posto da API de Revendedores da ANP. Posto com contorno branco não tem coordenada na ANP e aparece no centro do município. <a href=\"sobre\">Fontes, limites e privacidade</a>";
  }
  function desenhar() { if (modoPontos) atualizarPontos(); else desenharBolhas(); }
  function enquadrar() { if (modoPontos) enquadrarPontos(); else enquadrarBolhas(); }

  // ----------------------------------------------------------------- dados
  function json(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " → " + r.status); return r.json(); });
  }
  function carregarUF(uf) {
    if (cacheUF[uf]) return Promise.resolve(cacheUF[uf]);
    return json("dados/uf/" + uf + ".json").then(function (d) {
      cacheUF[uf] = d;
      d.municipios.forEach(function (m) { m.postos.forEach(function (p) { idxPosto[p[5]] = { m: m, p: p, uf: uf }; }); });
      return d;
    });
  }
  function munAtual() {
    if (!estado.uf || !estado.ibge || !cacheUF[estado.uf]) return null;
    return cacheUF[estado.uf].municipios.filter(function (m) { return m.ibge === estado.ibge; })[0] || null;
  }

  // ------------------------------------------------------------- seleção
  function selecionar(uf, ibge, semVoo) {
    return carregarUF(uf).then(function () {
      estado.uf = uf; estado.ibge = ibge || ""; estado.busca = ""; estado.mostrar = PAGINA;
      $("#busca").value = "";
      $("#uf").value = uf;
      preencherMunicipios();
      desenhar();
      if (!semVoo) enquadrar();
      renderizar();
      if (ibge) abrirFichaMunicipio();
      else fecharFicha();
      gravarHash();
    });
  }
  function limparSelecao(semVoo) {
    estado.uf = ""; estado.ibge = ""; estado.busca = ""; estado.mostrar = PAGINA;
    $("#uf").value = "";
    $("#mun").innerHTML = '<option value="">Todos</option>';
    $("#mun").disabled = true;
    $("#busca").value = "";
    fecharFicha();
    desenhar(); if (semVoo !== true) enquadrar(); renderizar(); gravarHash();
  }
  function preencherMunicipios() {
    var sel = $("#mun"), d = cacheUF[estado.uf];
    sel.innerHTML = '<option value="">Todos</option>';
    d.municipios.forEach(function (m) {
      if (!m.ibge) return;
      var o = document.createElement("option");
      o.value = m.ibge; o.textContent = m.nome + " (" + fmtN(m.n) + ")";
      sel.appendChild(o);
    });
    sel.disabled = false;
    sel.value = estado.ibge || "";
  }

  // ------------------------------------------------------------- renderização
  function escopo() {
    var d = estado.uf ? cacheUF[estado.uf] : null, m = munAtual();
    if (m) return { rotulo: m.nome + " – " + estado.uf, ranking: m.ranking, nivel: "município" };
    if (d) return { rotulo: R.ufs.filter(function (u) { return u.uf === estado.uf; })[0].nome, ranking: d.ranking, nivel: "estado" };
    return { rotulo: "Brasil", ranking: R.ranking_br, nivel: "Brasil" };
  }

  function renderProdutos() {
    $("#chips-prod").innerHTML = R.produtos.map(function (p) {
      return '<label class="chip"><input type="radio" name="prod" value="' + esc(p) + '"' + (p === estado.prod ? " checked" : "") + "><span>" + esc(p) + "</span></label>";
    }).join("") || '<div class="nota" style="margin:0">Sem preços carregados: o mapa mostra só o cadastro.</div>';
    $$("input[name=prod]").forEach(function (i) {
      i.addEventListener("change", function () { estado.prod = i.value; desenhar(); renderLegenda(); renderTop3(); renderPerto(); gravarHash(); if ($("#ficha").dataset.tipo === "mun") abrirFichaMunicipio(); });
    });
  }

  function renderLegenda() {
    var el = $("#legenda");
    if (modoPontos) { el.innerHTML = estado.cor === "preco" ? legendaPrecoPontos() : ""; return; }
    if (estado.cor === "preco") {
      var e = escalaPreco();
      el.innerHTML = e
        ? '<div class="gradiente" aria-hidden="true"></div><div class="gradiente-rotulos"><span>' + fmtPreco(e.min, estado.prod) + "</span><span>" + fmtPreco(e.max, estado.prod) + '</span></div>' +
          '<div class="nota" style="margin-top:6px">Média do município, entre os postos com preço coletado (faixa entre os percentis 5 e 95). Cinza: sem preço de ' + esc(estado.prod) + ".</div>"
        : '<div class="nota">Sem preço coletado de ' + esc(estado.prod || "nenhum combustível") + " neste recorte.</div>";
    } else {
      var itens = [["#1687ff", "1 a 9 postos"], ["#26d7e8", "10 a 49"], ["#F5B400", "50 a 199"], ["#e05050", "200 ou mais"]];
      el.innerHTML = '<div style="margin-top:8px">' + itens.map(function (i) {
        return '<div class="legenda-item"><span class="quadro" style="background:' + i[0] + '"></span>' + i[1] + "</div>";
      }).join("") + "</div>";
    }
  }

  function itemTop3(e, i) {
    var sub = [e.bandeira, [e.endereco, e.bairro].filter(Boolean).join(" – "), e.municipio + "/" + e.uf + " · coleta " + fmtData(e.data)].filter(Boolean).join(" · ");
    return '<button type="button" class="item-lista top3-item" data-uf="' + esc(e.uf) + '" data-ibge="' + esc(e.ibge) + '" data-cnpj="' + esc(e.cnpj) + '">' +
      '<span class="top3-pos">' + (i + 1) + '</span><span style="min-width:0"><span class="top3-nome">' + esc(e.nome || "(sem nome)") + '</span><span class="top3-sub" title="' + esc(sub) + '">' + esc(sub) + "</span></span>" +
      '<span class="top3-preco">' + fmtPreco(e.preco, estado.prod) + "</span></button>";
  }
  function renderTop3() {
    var s = escopo();
    $("#tit-top3").textContent = "Top 3 · " + (estado.prod || "—") + " · " + s.rotulo;
    var aviso = "";
    if (R.periodo_precos) {
      var dias = Math.round((new Date((R.gerado_em || "").slice(0, 10) + "T00:00:00Z") - new Date(R.periodo_precos[1] + "T00:00:00Z")) / 864e5);
      if (dias > 30) aviso = '<div class="msg erro">Atenção: a última coleta de preços publicada pela ANP é de ' + fmtData(R.periodo_precos[1]) + " (há " + dias + " dias). Os preços podem ter mudado.</div>";
    }
    var r = s.ranking && s.ranking[estado.prod];
    if (!r) {
      $("#top3").innerHTML = aviso + '<div class="msg">Sem preço coletado de ' + esc(estado.prod) + " em " + esc(s.rotulo) + " na janela de " + R.janela_dias + " dias." +
        (s.nivel === "município" ? " Escolha o estado inteiro para ver o ranking dele." : "") + "</div>";
      return;
    }
    var bloco = function (cls, tit, lista) {
      return '<div class="top3-grupo ' + cls + '"><div class="top3-titulo ' + cls + '">' + (cls === "bar" ? "▼" : "▲") + " " + tit + '</div><div class="lista">' + lista.map(itemTop3).join("") + "</div></div>";
    };
    $("#top3").innerHTML = aviso + bloco("bar", "3 mais baratos", r.baratos) + bloco("car", "3 mais caros", r.caros) +
      (r.baratos.length < 3 ? '<div class="msg">Há menos de 3 postos com preço neste recorte.</div>' : "");
    $$("#top3 .item-lista").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.ibge) selecionar(b.dataset.uf, b.dataset.ibge).then(function () { abrirFichaPosto(b.dataset.cnpj); });
      });
    });
  }

  function postosDoEscopo() {
    if (!estado.uf) return null;
    var d = cacheUF[estado.uf], out = [];
    d.municipios.forEach(function (m) {
      if (estado.ibge && m.ibge !== estado.ibge) return;
      m.postos.forEach(function (p) { out.push({ m: m, p: p }); });
    });
    return out;
  }

  function tagsPreco(p) {
    var h = Object.keys(p[6]).map(function (k) {
      return '<span class="tag">' + esc(k) + " " + fmtPreco(p[6][k][0], k).replace("/L", "") + "</span>";
    }).join("");
    return h ? '<div class="tags">' + h + "</div>" : "";
  }

  function renderLista() {
    var base = postosDoEscopo(), ul = $("#lista");
    $("#busca").disabled = !base;
    if (!base) {
      ul.innerHTML = ""; $("#mais").hidden = true;
      $("#lista-info").textContent = "Escolha um estado (ou clique num município no mapa) para listar os postos.";
      return;
    }
    var q = norm(estado.busca).trim();
    var f = q ? base.filter(function (x) { return norm([x.m.nome, x.p[0], x.p[1], x.p[2], x.p[3], x.p[5]].join(" ")).indexOf(q) >= 0; }) : base;
    var fatia = f.slice(0, estado.mostrar);
    $("#lista-info").textContent = fmtN(f.length) + " posto" + (f.length === 1 ? "" : "s") + (q ? " encontrados" : " cadastrados");
    ul.innerHTML = fatia.map(function (x) {
      var p = x.p;
      return '<div class="item-lista posto-item" data-cnpj="' + esc(p[5]) + '"><span class="nome">' + esc(p[0]) + '</span><span class="sub">' +
        esc(p[1]) + " · " + esc(p[2]) + (p[3] ? " – " + esc(p[3]) : "") + (p[4] ? " · CEP " + esc(p[4]) : "") + "<br>" + esc(x.m.nome) + " · CNPJ " + esc(fmtCnpj(p[5])) + "</span>" + tagsPreco(p) + "</div>";
    }).join("");
    $("#mais").hidden = f.length <= fatia.length;
    $$("#lista .posto-item").forEach(function (el) { el.style.cursor = "pointer"; el.addEventListener("click", function () { abrirFichaPosto(el.dataset.cnpj); }); });
  }

  function renderResumo() {
    var total, bands = {};
    var d = estado.uf ? cacheUF[estado.uf] : null, m = munAtual();
    if (m) { total = m.n; m.postos.forEach(function (p) { var b = (p[1] || "BANDEIRA BRANCA").toUpperCase(); bands[b] = (bands[b] || 0) + 1; }); }
    else if (d) { total = 0; d.municipios.forEach(function (mm) { total += mm.n; mm.postos.forEach(function (p) { var b = (p[1] || "BANDEIRA BRANCA").toUpperCase(); bands[b] = (bands[b] || 0) + 1; }); }); }
    else { total = R.n_postos; R.bandeiras.forEach(function (b) { bands[b[0]] = b[1]; }); }
    var arr = Object.keys(bands).map(function (k) { return [k, bands[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var topo = arr.slice(0, 8), resto = arr.slice(8).reduce(function (s, x) { return s + x[1]; }, 0);
    if (resto) topo.push(["Outras", resto]);
    var max = topo.length ? topo[0][1] : 1;
    var cores = ["#1687ff", "#26d7e8", "#F5B400", "#2db86a", "#a78bfa", "#e08c00", "#e05050", "#7dd3fc", "#94a3b8"];
    $("#resumo").innerHTML =
      '<div class="resumo-total"><b style="font-weight:inherit">' + fmtN(total) + "</b> <span>postos · " + esc(escopo().rotulo) + "</span></div>" +
      '<div class="resumo-bloco"><h3>Por bandeira</h3>' + topo.map(function (b, i) {
        return '<div class="barra-linha"><span class="barra-rotulo" title="' + esc(b[0]) + '"><span class="bolinha" style="background:' + cores[i % cores.length] + '"></span>' + esc(b[0]) +
          '</span><span class="barra-trilho"><span class="barra-cheia" style="width:' + Math.max(2, 100 * b[1] / max) + "%;background:" + cores[i % cores.length] + '"></span></span><span class="barra-num">' + fmtN(b[1]) + "</span></div>";
      }).join("") + "</div>";
  }

  function renderTotais() {
    $("#total-info").textContent = fmtN(R.n_postos);
  }

  function renderizar() {
    renderLegenda(); renderTop3(); renderLista(); renderResumo();
  }

  // ------------------------------------------------------------------ ficha
  function fecharFicha() { var f = $("#ficha"); f.hidden = true; f.innerHTML = ""; f.dataset.tipo = ""; }
  function mapsLink(q) { return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q); }

  function abrirFichaMunicipio() {
    var m = munAtual(); if (!m) return;
    var pr = R.municipios.filter(function (x) { return x[0] === m.ibge; })[0];
    var med = pr && pr[6] && pr[6][estado.prod];
    var r = m.ranking && m.ranking[estado.prod];
    var com = m.postos.filter(function (p) { return Object.keys(p[6]).length; }).length;
    var f = $("#ficha");
    f.dataset.tipo = "mun";
    f.innerHTML =
      '<div class="ficha-topo"><span class="ficha-op">' + esc(m.nome) + '</span><span class="ficha-num">' + esc(estado.uf) + '</span><button id="fechar-ficha" type="button" aria-label="Fechar">×</button></div>' +
      '<div class="ficha-linha"><span>Postos cadastrados</span><strong>' + fmtN(m.n) + "</strong></div>" +
      '<div class="ficha-linha"><span>Com preço recente</span><strong>' + fmtN(com) + "</strong></div>" +
      '<div class="ficha-linha"><span>' + esc(estado.prod) + " (média)</span><strong>" + (med ? fmtPreco(med[0], estado.prod) + " · " + med[1] + " postos" : "sem coleta") + "</strong></div>" +
      (r ? '<div class="ficha-linha"><span>Mais barato</span><strong style="color:var(--cor-barato)">' + fmtPreco(r.baratos[0].preco, estado.prod) + '</strong></div>' +
           '<div class="ficha-linha"><span>Mais caro</span><strong style="color:var(--cor-caro)">' + fmtPreco(r.caros[0].preco, estado.prod) + "</strong></div>" : "") +
      '<div class="ficha-links"><a href="' + mapsLink(m.nome + ", " + estado.uf + ", Brasil") + '" target="_blank" rel="noopener">Abrir no Google Maps</a></div>';
    f.hidden = false;
    $("#fechar-ficha").addEventListener("click", fecharFicha);
  }

  function achaPosto(cnpj) { return idxPosto[cnpj] || null; }

  function abrirFichaPosto(cnpj) {
    var achado = achaPosto(cnpj);
    if (!achado) return;
    var p = achado.p, f = $("#ficha");
    f.dataset.tipo = "posto";
    var precos = Object.keys(p[6]).map(function (k) {
      return '<div class="ficha-linha"><span>' + esc(k) + "</span><strong>" + fmtPreco(p[6][k][0], k) + ' <small style="color:var(--muted)">' + fmtData(p[6][k][1]) + "</small></strong></div>";
    }).join("");
    f.innerHTML =
      '<div class="ficha-topo"><span class="ficha-op" style="font-size:15px">' + esc(p[0]) + '</span><button id="fechar-ficha" type="button" aria-label="Fechar">×</button></div>' +
      '<div class="ficha-endereco">' + esc(p[2]) + (p[3] ? " – " + esc(p[3]) : "") + "<br>" + esc(achado.m.nome) + "/" + esc(achado.uf) + (p[4] ? " · CEP " + esc(p[4]) : "") + "</div>" +
      '<div class="ficha-linha"><span>Bandeira</span><strong>' + esc(p[1]) + "</strong></div>" +
      '<div class="ficha-linha"><span>CNPJ</span><code>' + esc(fmtCnpj(p[5])) + "</code></div>" +
      (precos || '<div class="ficha-linha"><span>Preços</span><strong>sem coleta recente</strong></div>') +
      '<div class="botoes" style="margin:8px 0 0"><button id="ficha-fav" type="button" aria-pressed="' + (ehFavoritoPosto(cnpj) ? "true" : "false") + '">' + (ehFavoritoPosto(cnpj) ? "★ Posto favorito" : "☆ Favoritar este posto") + '</button></div>' +
      '<div class="ficha-links"><a href="' + mapsLink([p[2], p[3], achado.m.nome, achado.uf, "Brasil"].filter(Boolean).join(", ")) + '" target="_blank" rel="noopener">Abrir endereço no Google Maps</a></div>' +
      '<div class="nota">' + (p[7] != null ? "Posição informada pela ANP no cadastro do posto; a precisão varia." : "A ANP não informa a coordenada deste posto: o ponto no mapa é o centro do município.") + "</div>";
    f.hidden = false;
    $("#fechar-ficha").addEventListener("click", fecharFicha);
    $("#ficha-fav").addEventListener("click", function () {
      var ativo = alternarFavoritoPosto(cnpj), b = this;
      b.setAttribute("aria-pressed", ativo ? "true" : "false");
      b.textContent = ativo ? "★ Posto favorito" : "☆ Favoritar este posto";
      if (ativo && window.Painel) window.Painel.abrir($("#secao-lugares"));
    });
  }

  // ------------------------------------------------------------------ busca
  var tBusca;
  function buscar() {
    var q = norm($("#entrada").value).trim(), box = $("#resultados");
    if (q.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
    var soDig = q.replace(/[\s.-]/g, "");
    if (/^\d+$/.test(soDig) && soDig.length <= 8) {   // parece CEP
      if (soDig.length === 8) { box.hidden = true; buscarCEP(soDig); return; }
      box.innerHTML = '<div class="msg">CEP com 8 dígitos: digite o resto (ou aperte Enter) para ver os postos mais próximos.</div>'; box.hidden = false; return;
    }
    var muns = R.municipios.filter(function (m) { return (!estado.uf || m[2] === estado.uf) && norm(m[1]).indexOf(q) >= 0; })
      .sort(function (a, b) { return (norm(a[1]).indexOf(q) === 0 ? 0 : 1) - (norm(b[1]).indexOf(q) === 0 ? 0 : 1) || b[5] - a[5]; }).slice(0, 8);
    var postos = [];
    var digitos = q.replace(/\D/g, "");
    if (estado.uf && cacheUF[estado.uf]) {
      cacheUF[estado.uf].municipios.some(function (m) {
        m.postos.some(function (p) {
          if (norm([p[0], p[1], p[3]].join(" ")).indexOf(q) >= 0 || (digitos.length >= 4 && p[5].indexOf(digitos) >= 0)) postos.push({ m: m, p: p });
          return postos.length >= 10;
        });
        return postos.length >= 10;
      });
    }
    var h = muns.map(function (m) {
      return '<button type="button" class="item-lista" data-t="m" data-uf="' + esc(m[2]) + '" data-ibge="' + esc(m[0]) + '"><span>📍 <strong>' + esc(m[1]) + " – " + esc(m[2]) + '</strong></span><span class="sub">' + fmtN(m[5]) + " postos</span></button>";
    }).join("") + postos.map(function (x) {
      return '<button type="button" class="item-lista" data-t="p" data-uf="' + esc(estado.uf) + '" data-ibge="' + esc(x.m.ibge) + '" data-cnpj="' + esc(x.p[5]) + '"><span>⛽ <strong>' + esc(x.p[0]) + '</strong></span><span class="sub">' + esc(x.m.nome) + "</span></button>";
    }).join("");
    if (!h) h = '<div class="msg">Nada encontrado' + (estado.uf ? "" : ". Para achar um posto, escolha antes o estado") + ".</div>";
    box.innerHTML = h; box.hidden = false;
    $$("#resultados .item-lista").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.t === "m") registrarRecente((b.querySelector("strong").textContent || "").split(" – ")[0]);
        box.hidden = true; $("#entrada").value = "";
        selecionar(b.dataset.uf, b.dataset.ibge).then(function () { if (b.dataset.t === "p") abrirFichaPosto(b.dataset.cnpj); });
      });
    });
  }

  // ------------------------------------------------------- postos mais próximos
  var ctxPerto = null, markerBusca = null;
  function setErro(t, ok) { var e = $("#erro"); e.textContent = t || ""; e.className = "msg" + (t ? (ok ? " ok" : " erro") : ""); }
  function km(a, b, c, d) {
    var r = Math.PI / 180, dLa = (c - a) * r, dLo = (d - b) * r;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 12742 * Math.asin(Math.sqrt(h));
  }
  function fetchJSON(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 7000);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }
  function municipioPorIbge(ibge) { return R.municipios.filter(function (m) { return m[0] === ibge; })[0] || null; }

  function buscarCEP(cep) {
    cep = String(cep).replace(/\D/g, "");
    if (cep.length !== 8) { setErro("Digite um CEP com 8 dígitos."); return; }
    setErro("Consultando o CEP…", true);
    fetchJSON("https://viacep.com.br/ws/" + cep + "/json/").then(function (v) {
      if (v.erro) { setErro("CEP não encontrado. Confira os números."); return; }
      var m = municipioPorIbge(String(v.ibge));
      if (!m) { setErro("Achei o CEP (" + (v.localidade || "") + "/" + (v.uf || "") + "), mas não localizei o município no mapa."); return; }
      setErro("");
      registrarRecente(cep.replace(/^(\d{5})(\d{3})$/, "$1-$2"));
      var rotulo = "CEP " + cep.replace(/^(\d{5})(\d{3})$/, "$1-$2") + [v.logradouro, v.bairro].filter(Boolean).map(function (x) { return " · " + x; }).join("") + " · " + m[1] + "/" + m[2];
      if (modoPontos) return posicaoDoCEP(m, parseInt(cep, 10)).then(function (pos) { return procurarRaio({ lat: pos[0], lon: pos[1], rotulo: rotulo + (pos[2] ? " · pino perto dos postos de CEP vizinho; arraste para ajustar" : " · pino no centro do município; arraste para ajustar"), exato: false }); });
      return procurarProximos({ lat: m[3], lon: m[4], ibge: m[0], cep: parseInt(cep, 10), rotulo: rotulo, exato: false });
    }).catch(function () { setErro("Não consegui consultar o CEP agora (ViaCEP fora do ar ou sem internet). Tente de novo ou escolha o município."); });
  }

  function usarLocal() {
    var b = $("#usar-local");
    if (!navigator.geolocation) { setErro("Este navegador não oferece localização."); return; }
    b.disabled = true; setErro("Pedindo a localização ao aparelho…", true);
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      setErro("Localização obtida. Procurando o CEP e o município do ponto…", true);
      var cand = R.municipios.map(function (m) { return { m: m, d: km(lat, lon, m[3], m[4]) }; }).sort(function (a, c) { return a.d - c.d; }).slice(0, 6);
      if (cand[0].d > 150) { b.disabled = false; setErro("Você parece estar a mais de 150 km de qualquer município com postos no mapa (fora do Brasil?)."); return; }
      if (modoPontos) {
        b.disabled = false; setErro("");
        return procurarRaio({ lat: lat, lon: lon, exato: true, rotulo: "Sua localização · " + cand[0].m[1] + "/" + cand[0].m[2] + " (±" + Math.round(pos.coords.accuracy) + " m)" });
      }
      // OpenStreetMap devolve CEP e cidade do ponto; sem ele, usamos o município de centro mais próximo.
      fetchJSON("https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=pt-BR&lat=" + lat + "&lon=" + lon, 6000)
        .catch(function () { return null; })
        .then(function (r) {
          var a = (r && r.address) || {}, cep = null, prim = cand[0].m;
          var cm = String(a.postcode || "").replace(/\D/g, "");
          if (cm.length === 8) cep = parseInt(cm, 10);
          var nome = norm(a.city || a.town || a.village || a.municipality || a.city_district || "");
          if (nome) { cand.some(function (c) { if (norm(c.m[1]) === nome) { prim = c.m; return true; } return false; }); }
          return procurarProximos({ lat: lat, lon: lon, ibge: prim[0], cep: cep, exato: true,
            rotulo: "Sua localização" + (cep ? " · CEP " + String(cm).replace(/^(\d{5})(\d{3})$/, "$1-$2") : "") + " · " + prim[1] + "/" + prim[2] + " (±" + Math.round(pos.coords.accuracy) + " m)" });
        }).then(function () { b.disabled = false; setErro(""); }, function () { b.disabled = false; });
    }, function (e) {
      b.disabled = false;
      setErro(e.code === 1 ? "Permissão de localização negada. Libere no cadeado da barra de endereço, ou digite o CEP." :
        e.code === 3 ? "A localização demorou demais. Tente de novo ou digite o CEP." : "Não consegui obter a localização. Digite o CEP.");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  function procurarProximos(o) { return modoPontos ? procurarRaio(o) : procurarProximosAprox(o); }
  function procurarProximosAprox(o) {
    // município principal + vizinhos num raio de 35 km (ordenados por distância ao ponto)
    var viz = R.municipios.filter(function (m) { return m[0] !== o.ibge; })
      .map(function (m) { return { m: m, d: km(o.lat, o.lon, m[3], m[4]) }; })
      .filter(function (x) { return x.d <= 35; }).sort(function (a, c) { return a.d - c.d; }).slice(0, 8);
    var prim = municipioPorIbge(o.ibge);
    var lista = [{ m: prim, d: km(o.lat, o.lon, prim[3], prim[4]), principal: true }].concat(viz);
    var ufs = {}; lista.forEach(function (x) { ufs[x.m[2]] = 1; });
    return Promise.all(Object.keys(ufs).map(carregarUF)).then(function () {
      var itens = [];
      lista.forEach(function (x) {
        var d = cacheUF[x.m[2]].municipios.filter(function (mm) { return mm.ibge === x.m[0]; })[0];
        if (!d) return;
        d.postos.forEach(function (p) {
          var cp = parseInt(p[4], 10), dif = (o.cep != null && !isNaN(cp)) ? Math.abs(cp - o.cep) : Infinity;
          itens.push({ p: p, mun: x.m, d: x.d, principal: !!x.principal, dif: dif });
        });
      });
      itens.sort(function (a, c) {
        if (a.principal !== c.principal) return a.principal ? -1 : 1;
        if (a.principal) { if (a.dif !== c.dif) return a.dif - c.dif; return 0; }
        return a.d - c.d;
      });
      ctxPerto = { o: o, itens: itens, mostrar: 15 };
      return selecionar(prim[2], prim[0], true).then(function () {
        fecharFicha();
        if (markerBusca) { mapa.removeLayer(markerBusca); markerBusca = null; }
        markerBusca = L.marker([o.lat, o.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: "marca-busca", html: '<div class="alvo-busca"><span class="radar"></span></div>', iconSize: [0, 0] }) }).addTo(mapa);
        mapa.flyTo([o.lat, o.lon], o.exato ? 12 : 11, { animate: !MENOS_MOVIMENTO, duration: 0.8 });
        renderPerto();
        var sec = $("#secao-perto"); sec.hidden = false; sec.classList.remove("recolhida");
        try { sec.scrollIntoView({ behavior: MENOS_MOVIMENTO ? "auto" : "smooth", block: "start" }); } catch (e) { /* ok */ }
      });
    });
  }

  function seloPerto(it, o) {
    if (it.principal) {
      if (o.cep != null && isFinite(it.dif)) return it.dif < 1000 ? ['', 'região do CEP'] : ['', 'mesmo município'];
      return ['', 'mesmo município'];
    }
    return ['viz', "~" + Math.max(1, Math.round(it.d)) + " km · " + it.mun[1]];
  }

  function renderPerto() {
    if (!ctxPerto) return;
    if (ctxPerto.modo === "raio") return renderPertoRaio();
    var c = ctxPerto, o = c.o, fatia = c.itens.slice(0, c.mostrar);
    $("#perto-cabeca").innerHTML = "<strong>" + esc(o.rotulo) + "</strong><br>" + fmtN(c.itens.length) + " postos no município e em municípios num raio de 35 km. Mostrando os " + fmtN(fatia.length) + " mais próximos.";
    $("#perto-lista").innerHTML = fatia.map(function (it, i) {
      var p = it.p, sl = seloPerto(it, o), pr = p[6] && p[6][estado.prod];
      return '<div class="item-lista perto-item" data-cnpj="' + esc(p[5]) + '"><span class="perto-pos">' + (i + 1) + '</span><span style="min-width:0">' +
        '<span class="top3-nome" style="white-space:normal">' + esc(p[0]) + "</span>" +
        '<span class="top3-sub" style="white-space:normal"><span class="selo ' + sl[0] + '">' + esc(sl[1]) + "</span>" + esc([p[1], p[2], p[3]].filter(Boolean).join(" · ")) + (p[4] ? " · CEP " + esc(p[4]) : "") + "</span></span>" +
        '<span class="top3-preco" style="color:var(--text)">' + (pr ? fmtPreco(pr[0], estado.prod) : "") + "</span></div>";
    }).join("") || '<div class="msg">Nenhum posto cadastrado por perto.</div>';
    $("#perto-mais").hidden = c.itens.length <= fatia.length;
    $$("#perto-lista .perto-item").forEach(function (el) { el.addEventListener("click", function () { abrirFichaPosto(el.dataset.cnpj); }); });
  }

  function fecharPerto() {
    ctxPerto = null; $("#secao-perto").hidden = true;
    if (markerBusca) { mapa.removeLayer(markerBusca); markerBusca = null; }
    [pino, circuloRaio, destaquePerto].forEach(function (l) { if (l && mapa.hasLayer(l)) mapa.removeLayer(l); });
    pino = null; circuloRaio = null; destaquePerto = null;
  }

  // ---------- busca por raio (cada posto tem coordenada: distância em linha reta a partir de um pino)
  var raioKm = 5, pino = null, circuloRaio = null, rendSvg = null, destaquePerto = null, tokenPerto = 0, rafPerto = 0;

  function posicaoDoCEP(m, cep) {
    // posição do pino: mediana dos 3 postos do município com CEP mais parecido e coordenada da ANP
    return carregarUF(m[2]).then(function (d) {
      var mun = d.municipios.filter(function (x) { return x.ibge === m[0]; })[0], c = [];
      if (mun) mun.postos.forEach(function (p) { var cp = parseInt(p[4], 10); if (p[7] != null && !isNaN(cp)) c.push({ dif: Math.abs(cp - cep), la: p[7], lo: p[8] }); });
      c.sort(function (a, b) { return a.dif - b.dif; });
      c = c.slice(0, 3);
      if (!c.length) return [m[3], m[4], false];
      var med = function (k) { var v = c.map(function (x) { return x[k]; }).sort(function (a, b) { return a - b; }); return v[Math.floor(v.length / 2)]; };
      return [med("la"), med("lo"), true];
    });
  }

  function colocarPino(lat, lon) {
    if (!rendSvg) rendSvg = L.svg({ padding: 0.5 }).addTo(mapa);
    if (!pino) {
      pino = L.marker([lat, lon], { draggable: true, keyboard: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: "pino-arrastavel", html: '<div class="alvo-busca"><span class="radar"></span></div>', iconSize: [40, 40] }) }).addTo(mapa);
      pino.on("dragstart", function () { pino.getElement().classList.add("arrastando"); });
      pino.on("drag", moverPino);
      pino.on("dragend", function () { var el = pino.getElement(); if (el) el.classList.remove("arrastando"); moverPino(); });
    } else pino.setLatLng([lat, lon]);
    if (!circuloRaio) circuloRaio = L.circle([lat, lon], { radius: raioKm * 1000, renderer: rendSvg, className: "raio-busca", interactive: false }).addTo(mapa);
    else circuloRaio.setLatLng([lat, lon]);
    if (!destaquePerto) destaquePerto = L.layerGroup().addTo(mapa);
  }

  function moverPino() {
    if (!pino || !ctxPerto) return;
    var ll = pino.getLatLng(), o = ctxPerto.o;
    o.lat = ll.lat; o.lon = ll.lng; o.exato = true;
    o.rotulo = "Ponto no mapa · " + ll.lat.toFixed(5) + ", " + ll.lng.toFixed(5);
    circuloRaio.setLatLng(ll);
    if (!rafPerto) rafPerto = L.Util.requestAnimFrame(function () { rafPerto = 0; atualizarRaio(false); });
  }

  function procurarRaio(o) {
    var ja = ctxPerto && ctxPerto.modo === "raio";
    ctxPerto = { o: o, mostrar: 15, modo: "raio", itens: [] };
    if (estado.uf || estado.ibge) limparSelecao(true);   // sem filtro de município: todos os pontos à volta aparecem
    fecharFicha();
    colocarPino(o.lat, o.lon);
    $("#bloco-raio").hidden = false;
    $("#perto-nota").innerHTML = "Distância em linha reta a partir do pino. <strong>Arraste o pino</strong> ou <strong>clique no mapa</strong> para mudar o ponto, e use o raio para ampliar ou reduzir a busca. Posto marcado como “posição aproximada” não tem coordenada na ANP: ele fica no centro do município, então a distância dele é só uma estimativa.";
    var sec = $("#secao-perto"); sec.hidden = false; sec.classList.remove("recolhida");
    atualizarRaio(true);
    if (!ja) { try { sec.scrollIntoView({ behavior: MENOS_MOVIMENTO ? "auto" : "smooth", block: "start" }); } catch (e) { /* ok */ } }
    return Promise.resolve();
  }

  function atualizarRaio(enquadra) {
    var c = ctxPerto; if (!c || c.modo !== "raio" || !PT) return;
    var o = c.o, r = raioKm, itens = [];
    var dLat = r / 111.2, dLon = r / (111.2 * Math.max(0.2, Math.cos(o.lat * Math.PI / 180)));
    for (var i = 0; i < PT.n; i++) {
      if (Math.abs(PT.lat[i] - o.lat) > dLat || Math.abs(PT.lon[i] - o.lon) > dLon) continue;
      if (filtro.ocultas[bandGrupo(PT.b[i])]) continue;
      var d = km(o.lat, o.lon, PT.lat[i], PT.lon[i]);
      if (d <= r) itens.push({ i: i, d: d });
    }
    itens.sort(function (a, b) { return a.d - b.d; });
    c.itens = itens;
    circuloRaio.setRadius(r * 1000);
    $("#raio-valor").textContent = r + " km";
    if (enquadra) mapa.fitBounds(circuloRaio.getBounds().pad(0.15), { animate: !MENOS_MOVIMENTO, maxZoom: 16 });
    renderPertoRaio();
  }

  function renderPertoRaio() {
    var c = ctxPerto, o = c.o, fatia = c.itens.slice(0, c.mostrar), tk = ++tokenPerto, ufs = {};
    fatia.forEach(function (x) { ufs[PT.uf[PT.u[x.i]]] = 1; });
    $("#perto-cabeca").innerHTML = "<strong>" + esc(o.rotulo) + "</strong><br>" + (c.itens.length
      ? fmtN(c.itens.length) + " posto" + (c.itens.length > 1 ? "s" : "") + " em até " + raioKm + " km. Mostrando os " + fmtN(fatia.length) + " mais próximos."
      : "Nenhum posto em até " + raioKm + " km. Aumente o raio.");
    destaquePerto.clearLayers();
    fatia.forEach(function (x, k) {
      L.marker([PT.lat[x.i], PT.lon[x.i]], { interactive: false, keyboard: false, icon: L.divIcon({ className: "num-perto", html: "<span>" + (k + 1) + "</span>", iconSize: [20, 20] }) }).addTo(destaquePerto);
    });
    $("#perto-mais").hidden = c.itens.length <= fatia.length;
    Promise.all(Object.keys(ufs).map(carregarUF)).then(function () {
      if (tk !== tokenPerto || ctxPerto !== c) return;
      var pi = PT.prod.indexOf(estado.prod), np = Math.max(1, PT.prod.length);
      $("#perto-lista").innerHTML = fatia.map(function (x, k) {
        var a = idxPosto[PT.c[x.i]], p = a && a.p, pr = pi >= 0 ? PT.preco[x.i * np + pi] : NaN;
        var dist = x.d < 1 ? Math.max(10, Math.round(x.d * 100) * 10) + " m" : x.d.toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + " km";
        return '<div class="item-lista perto-item" data-i="' + x.i + '"><span class="perto-pos">' + (k + 1) + '</span><span style="min-width:0">' +
          '<span class="top3-nome" style="white-space:normal">' + esc(p ? p[0] : PT.nome[x.i]) + "</span>" +
          '<span class="top3-sub" style="white-space:normal"><span class="selo ' + (PT.e[x.i] ? "" : "viz") + '">' + dist + (PT.e[x.i] ? "" : " · posição aproximada") + "</span>" +
          esc(p ? [p[1], p[2], p[3]].filter(Boolean).join(" · ") : PT.band[PT.b[x.i]]) + "</span></span>" +
          '<span class="top3-preco" style="color:var(--text)">' + (pr === pr ? fmtPreco(pr, estado.prod) : "") + "</span></div>";
      }).join("") || '<div class="msg">Nenhum posto cadastrado por perto.</div>';
      $$("#perto-lista .perto-item").forEach(function (el) {
        el.addEventListener("click", function () {
          var i = +el.dataset.i;
          abrirFichaPosto(PT.c[i]);
          mapa.flyTo([PT.lat[i], PT.lon[i]], Math.max(mapa.getZoom(), 15), { animate: !MENOS_MOVIMENTO, duration: 0.6 });
        });
      });
    });
  }

  // ------------------------------------------------ meus lugares (favoritos e buscas recentes)
  // Fica no localStorage deste navegador (anp.lugares.v1). Nada é enviado.
  var CHAVE_LUGARES = "anp.lugares.v1", MAX_FAV = 20, MAX_REC = 8;
  var lugares = { fav: [], rec: [] };
  function dentroDoBrasil(la, lo) { return isFinite(la) && isFinite(lo) && la >= -34 && la <= 6 && lo >= -74.5 && lo <= -28; }
  function carregarLugares() {
    try {
      var x = JSON.parse(localStorage.getItem(CHAVE_LUGARES) || "null");
      if (!x) return;
      lugares.fav = (x.fav || []).filter(function (f) { return f && typeof f.nome === "string" && dentroDoBrasil(f.lat, f.lon) && (f.cnpj == null || (typeof f.cnpj === "string" && f.uf && f.ibge)); }).slice(0, MAX_FAV);
      lugares.rec = (x.rec || []).filter(function (q) { return typeof q === "string" && q; }).slice(0, MAX_REC);
    } catch (e) { /* storage indisponível: vale só nesta aba */ }
  }
  function gravarLugares() { try { localStorage.setItem(CHAVE_LUGARES, JSON.stringify(lugares)); } catch (e) { /* ok */ } }
  function registrarRecente(q) {
    q = String(q || "").trim().slice(0, 120);
    if (q.length < 2) return;
    var k = q.toLowerCase();
    lugares.rec = lugares.rec.filter(function (x) { return x.toLowerCase() !== k; });
    lugares.rec.unshift(q); lugares.rec = lugares.rec.slice(0, MAX_REC);
    gravarLugares(); renderizarLugares();
  }
  function renderizarLugares() {
    $("#lugares-favoritos").innerHTML = lugares.fav.map(function (f, i) {
      return '<div class="lugar" role="listitem"><button type="button" class="lugar-ir" data-fav="' + i + '" title="Ver os postos perto deste lugar"><span class="estrela" aria-hidden="true">' + (f.cnpj ? "⛽" : "★") + '</span>' + esc(f.nome) + '</button>' +
        '<button type="button" class="lugar-x" data-del-fav="' + i + '" aria-label="Remover ' + esc(f.nome) + '" title="Remover">&times;</button></div>';
    }).join("");
    $("#lugares-recentes").innerHTML = lugares.rec.map(function (q, i) {
      return '<div class="lugar" role="listitem"><button type="button" class="lugar-ir" data-rec="' + i + '" title="Buscar de novo"><span class="relogio" aria-hidden="true">↺</span>' + esc(q) + '</button>' +
        '<button type="button" class="lugar-x" data-del-rec="' + i + '" aria-label="Remover ' + esc(q) + ' das buscas recentes" title="Remover">&times;</button></div>';
    }).join("");
    $("#lugares-recentes-titulo").hidden = !lugares.rec.length;
    $("#lugares-limpar").hidden = !lugares.rec.length;
    $("#lugares-vazio").hidden = !!(lugares.fav.length || lugares.rec.length);
  }
  function salvarPontoAtual() {
    if (!ctxPerto) return;
    var o = ctxPerto.o, nome = ($("#salvar-nome").value || "").trim().slice(0, 60) || ("Ponto " + o.lat.toFixed(4) + ", " + o.lon.toFixed(4));
    var k = o.lat.toFixed(5) + "," + o.lon.toFixed(5);
    lugares.fav = lugares.fav.filter(function (f) { return f.cnpj || f.lat.toFixed(5) + "," + f.lon.toFixed(5) !== k; });
    lugares.fav.unshift({ nome: nome, lat: +o.lat.toFixed(6), lon: +o.lon.toFixed(6) });
    lugares.fav = lugares.fav.slice(0, MAX_FAV);
    gravarLugares(); renderizarLugares();
    $("#salvar-form").hidden = true;
    var b = $("#perto-salvar"); b.textContent = "★ Ponto salvo";
    setTimeout(function () { b.textContent = "☆ Salvar este ponto"; }, 1800);
    if (window.Painel) window.Painel.abrir($("#secao-lugares"));
  }
  function ehFavoritoPosto(cnpj) { return lugares.fav.some(function (f) { return f.cnpj === cnpj; }); }
  function alternarFavoritoPosto(cnpj) {
    var a = idxPosto[cnpj]; if (!a) return false;
    if (ehFavoritoPosto(cnpj)) { lugares.fav = lugares.fav.filter(function (f) { return f.cnpj !== cnpj; }); }
    else {
      var p = a.p, la = p[7] != null ? p[7] : a.m.lat, lo = p[8] != null ? p[8] : a.m.lon;
      lugares.fav.unshift({ nome: String(p[0]).slice(0, 60) + " · " + a.m.nome, lat: +la, lon: +lo, cnpj: cnpj, uf: a.uf, ibge: a.m.ibge });
      lugares.fav = lugares.fav.slice(0, MAX_FAV);
    }
    gravarLugares(); renderizarLugares();
    return ehFavoritoPosto(cnpj);
  }
  function rodarBusca(q) {   // repete uma busca digitada (CEP ou nome)
    $("#entrada").value = q; buscar();
    if (/[a-z]/i.test(q)) { var f = $("#resultados .item-lista"); if (f) f.click(); } else buscarCEP(q);
  }
  function ligarLugares() {
    carregarLugares(); renderizarLugares();
    $("#perto-salvar").addEventListener("click", function () {
      if (!ctxPerto) return;
      $("#salvar-nome").value = String(ctxPerto.o.rotulo || "").replace(/ · pino.*$/, "").slice(0, 60);
      $("#salvar-form").hidden = false; $("#salvar-nome").focus(); $("#salvar-nome").select();
    });
    $("#salvar-ok").addEventListener("click", salvarPontoAtual);
    $("#salvar-nome").addEventListener("keydown", function (e) {
      if (e.key === "Enter") salvarPontoAtual();
      else if (e.key === "Escape") { $("#salvar-form").hidden = true; $("#perto-salvar").focus(); }
    });
    $("#secao-lugares").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null; if (!b) return;
      var d = b.dataset;
      if (d.fav != null) {
        var f = lugares.fav[+d.fav]; if (!f) return;
        if (f.cnpj) {   // posto favorito: abre a ficha
          carregarUF(f.uf).then(function () {
            if (!idxPosto[f.cnpj]) return;
            return selecionar(f.uf, f.ibge, true).then(function () {
              abrirFichaPosto(f.cnpj);
              var p = idxPosto[f.cnpj].p, anim = !MENOS_MOVIMENTO;
              if (p[7] != null) mapa.flyTo([p[7], p[8]], 16, { animate: anim, duration: 0.7 });
              else mapa.flyTo([f.lat, f.lon], 12, { animate: anim, duration: 0.7 });
            });
          });
          return;
        }
        if (modoPontos) procurarRaio({ lat: f.lat, lon: f.lon, exato: true, rotulo: f.nome });
        else {
          var c = R.municipios.map(function (m) { return { m: m, d: km(f.lat, f.lon, m[3], m[4]) }; }).sort(function (a, z) { return a.d - z.d; })[0];
          procurarProximosAprox({ lat: f.lat, lon: f.lon, ibge: c.m[0], cep: null, exato: true, rotulo: f.nome });
        }
      } else if (d.rec != null) { var q = lugares.rec[+d.rec]; if (q) rodarBusca(q); }
      else if (d.delFav != null) { lugares.fav.splice(+d.delFav, 1); gravarLugares(); renderizarLugares(); }
      else if (d.delRec != null) { lugares.rec.splice(+d.delRec, 1); gravarLugares(); renderizarLugares(); }
      else if (b.id === "lugares-limpar") { lugares.rec = []; gravarLugares(); renderizarLugares(); }
    });
  }

  // ------------------------------------------------------------- hash / link
  function gravarHash() {
    var p = [];
    if (estado.uf) p.push("uf=" + estado.uf);
    if (estado.ibge) p.push("m=" + estado.ibge);
    if (estado.prod && estado.prod !== R.produtos[0]) p.push("p=" + encodeURIComponent(estado.prod));
    if (estado.cor !== "preco") p.push("c=" + estado.cor);
    try { history.replaceState(null, "", p.length ? "#" + p.join("&") : location.pathname + location.search); } catch (e) { /* file:// */ }
  }
  function lerHash() {
    var o = {};
    location.hash.replace(/^#/, "").split("&").forEach(function (kv) { var a = kv.split("="); if (a[0]) o[a[0]] = decodeURIComponent(a[1] || ""); });
    return o;
  }

  // ---------------------------------------------------------------- painel
  function configurarPainel() {
    var CH = "anp.painel.v1", salvo = {};
    try { salvo = JSON.parse(localStorage.getItem(CH) || "{}") || {}; } catch (e) { /* ok */ }
    var abertas = ["combustível", "top 3", "encontrar", "meus lugares", "resumo do filtro"];
    $$("#painel > .secao").forEach(function (s) {
      var h = s.querySelector(":scope > h2");
      if (!h || s.querySelector("#entrada") || s.id === "secao-perto") return;
      var chave = h.textContent.trim().toLowerCase().replace(/ ·.*$/, "");
      s.classList.add("recolhivel");
      h.setAttribute("role", "button"); h.tabIndex = 0;
      h.insertAdjacentHTML("beforeend", '<span class="caret" aria-hidden="true"></span>');
      var def = function (abre) { s.classList.toggle("recolhida", !abre); h.setAttribute("aria-expanded", abre ? "true" : "false"); h.querySelector(".caret").textContent = abre ? "▾" : "▸"; };
      def(chave in salvo ? !!salvo[chave] : abertas.indexOf(chave) >= 0);
      var alt = function () { var abre = s.classList.contains("recolhida"); def(abre); salvo[chave] = abre; try { localStorage.setItem(CH, JSON.stringify(salvo)); } catch (e) { /* ok */ } };
      h.addEventListener("click", alt);
      h.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alt(); } });
    });
    window.Painel = { abrir: function (sec) {   // abre uma seção recolhida (sem gravar a escolha): usado pelo tour
      if (!sec || !sec.classList.contains("recolhida")) return;
      sec.classList.remove("recolhida");
      var h = sec.querySelector(":scope > h2"); if (h) { h.setAttribute("aria-expanded", "true"); var c = h.querySelector(".caret"); if (c) c.textContent = "▾"; }
    } };
    var ajustar = function () { setTimeout(function () { mapa.invalidateSize(); }, 320); };
    $("#recolher-painel").addEventListener("click", function () {
      var rec = document.body.classList.toggle("painel-recolhido");
      this.setAttribute("aria-expanded", rec ? "false" : "true");
      ajustar();
    });
    $("#alternar-painel").addEventListener("click", function () {
      var ab = document.body.classList.toggle("painel-aberto");
      this.textContent = ab ? "Mapa" : "Filtros";
      ajustar();
    });
  }

  // --------------------------------------------------------------- iniciar
  function iniciar() {
    aplicarTema(lerTema() || "escuro");
    $("#tema").addEventListener("click", function () { aplicarTema(estado.tema === "claro" ? "escuro" : "claro"); });
    iniciarMapa();
    return json("dados/resumo.json").then(function (d) {
      R = d;
      if (R.demo) $("#aviso-demo").hidden = false;
      var h = lerHash();
      estado.prod = R.produtos.indexOf(h.p) >= 0 ? h.p : (R.produtos[0] || "");
      if (h.c === "postos") { estado.cor = "postos"; $$("input[name=cor]").forEach(function (i) { i.checked = i.value === "postos"; }); }

      var idade = $("#idade-base"), dia = (R.gerado_em || "").slice(0, 10);
      idade.textContent = "Base " + fmtData(dia);
      if (dia && (Date.now() - new Date(dia + "T00:00:00Z").getTime()) / 864e5 > 15) idade.classList.add("velha");
      $("#base-info").textContent = R.gerado_em;
      $("#periodo-info").textContent = R.periodo_precos ? fmtData(R.periodo_precos[0]) + " a " + fmtData(R.periodo_precos[1]) + " (janela de " + R.janela_dias + " dias)" : "indisponível";
      R.ufs.forEach(function (u) { var o = document.createElement("option"); o.value = u.uf; o.textContent = u.nome + " (" + fmtN(u.n) + ")"; $("#uf").appendChild(o); });

      renderProdutos(); renderTotais(); configurarPainel(); ligarLugares();
      var pPontos = (R.pontos_exatos || 0) > 0 ? json("dados/pontos.json").then(function (d) { prepararPontos(d); return true; }).catch(function () { return false; }) : Promise.resolve(false);
      return pPontos.then(function (ok) { if (ok) ativarPontos(); return d; });
    }).then(function (d) {
      var h = lerHash();
      $("#uf").addEventListener("change", function (e) { e.target.value ? selecionar(e.target.value, "") : limparSelecao(); });
      $("#mun").addEventListener("change", function (e) { selecionar(estado.uf, e.target.value); });
      $("#limpar").addEventListener("click", function () { limparSelecao(); });
      $$("input[name=cor]").forEach(function (i) { i.addEventListener("change", function () { estado.cor = i.value; desenhar(); renderLegenda(); gravarHash(); }); });
      $("#entrada").addEventListener("input", function () { clearTimeout(tBusca); tBusca = setTimeout(buscar, 120); });
      $("#entrada").addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        var d = $("#entrada").value.replace(/\D/g, ""), prim = $("#resultados .item-lista");
        if (d.length === 8 && !/[a-z]/i.test($("#entrada").value)) buscarCEP(d); else if (prim) prim.click();
      });
      $("#buscar").addEventListener("click", function () { $("#entrada").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); });
      $$(".exemplo").forEach(function (b) { b.addEventListener("click", function () { $("#entrada").value = b.dataset.q; buscar(); if (/[a-z]/i.test(b.dataset.q)) { var f = $("#resultados .item-lista"); if (f) f.click(); } else buscarCEP(b.dataset.q); }); });
      if (navigator.geolocation) { $("#usar-local").hidden = false; $("#usar-local").addEventListener("click", usarLocal); }
      $("#perto-mais").addEventListener("click", function () { ctxPerto.mostrar += 15; renderPerto(); });
      $("#raio").addEventListener("input", function (e) { raioKm = +e.target.value; $("#raio-valor").textContent = raioKm + " km"; if (ctxPerto && ctxPerto.modo === "raio") atualizarRaio(false); });
      $("#raio").addEventListener("change", function () { if (circuloRaio) mapa.fitBounds(circuloRaio.getBounds().pad(0.15), { animate: !MENOS_MOVIMENTO, maxZoom: 16 }); });
      $("#perto-fechar").addEventListener("click", fecharPerto);
      $("#busca").addEventListener("input", function (e) { estado.busca = e.target.value; estado.mostrar = PAGINA; renderLista(); });
      $("#mais").addEventListener("click", function () { estado.mostrar += PAGINA; renderLista(); });
      $("#copiar-link").addEventListener("click", function () {
        var b = this, ok = function () { b.textContent = "Copiado!"; setTimeout(function () { b.textContent = "Copiar link"; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(ok, function () { window.prompt("Copie o link:", location.href); });
        else window.prompt("Copie o link:", location.href);
      });
      $("#hud-zoom").textContent = "z " + mapa.getZoom();

      desenhar(); renderizar();
      if (h.uf && R.ufs.some(function (u) { return u.uf === h.uf; })) return selecionar(h.uf, h.m || "");
    }).catch(function (e) {
      $("#painel").insertAdjacentHTML("afterbegin", '<div class="secao"><div class="msg erro">Não foi possível carregar os dados: ' + esc(e.message) + "</div></div>");
    }).then(function () {
      var b = $("#boot"); b.classList.add("saindo"); setTimeout(function () { b.remove(); }, 700);
    });
  }

  iniciar();
})();
