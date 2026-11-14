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

  function desenhar() {
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

  function enquadrar() {
    var pts = R.municipios.filter(function (m) {
      return estado.ibge ? m[0] === estado.ibge : (!estado.uf || m[2] === estado.uf);
    }).map(function (m) { return [m[3], m[4]]; });
    if (!pts.length) return;
    var anim = !MENOS_MOVIMENTO;
    if (pts.length === 1) mapa.flyTo(pts[0], 11, { animate: anim, duration: 0.8 });
    else mapa.flyToBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 9, animate: anim, duration: 0.8 });
  }

  // ----------------------------------------------------------------- dados
  function json(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + " → " + r.status); return r.json(); });
  }
  function carregarUF(uf) {
    if (cacheUF[uf]) return Promise.resolve(cacheUF[uf]);
    return json("dados/uf/" + uf + ".json").then(function (d) { cacheUF[uf] = d; return d; });
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
  function limparSelecao() {
    estado.uf = ""; estado.ibge = ""; estado.busca = ""; estado.mostrar = PAGINA;
    $("#uf").value = "";
    $("#mun").innerHTML = '<option value="">Todos</option>';
    $("#mun").disabled = true;
    $("#busca").value = "";
    fecharFicha();
    desenhar(); enquadrar(); renderizar(); gravarHash();
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
      i.addEventListener("change", function () { estado.prod = i.value; desenhar(); renderLegenda(); renderTop3(); gravarHash(); if ($("#ficha").dataset.tipo === "mun") abrirFichaMunicipio(); });
    });
  }

  function renderLegenda() {
    var el = $("#legenda");
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

  function abrirFichaPosto(cnpj) {
    var achado = null;
    (postosDoEscopo() || []).some(function (x) { if (x.p[5] === cnpj) { achado = x; return true; } return false; });
    if (!achado) return;
    var p = achado.p, f = $("#ficha");
    f.dataset.tipo = "posto";
    var precos = Object.keys(p[6]).map(function (k) {
      return '<div class="ficha-linha"><span>' + esc(k) + "</span><strong>" + fmtPreco(p[6][k][0], k) + ' <small style="color:var(--muted)">' + fmtData(p[6][k][1]) + "</small></strong></div>";
    }).join("");
    f.innerHTML =
      '<div class="ficha-topo"><span class="ficha-op" style="font-size:15px">' + esc(p[0]) + '</span><button id="fechar-ficha" type="button" aria-label="Fechar">×</button></div>' +
      '<div class="ficha-endereco">' + esc(p[2]) + (p[3] ? " – " + esc(p[3]) : "") + "<br>" + esc(achado.m.nome) + "/" + esc(estado.uf) + (p[4] ? " · CEP " + esc(p[4]) : "") + "</div>" +
      '<div class="ficha-linha"><span>Bandeira</span><strong>' + esc(p[1]) + "</strong></div>" +
      '<div class="ficha-linha"><span>CNPJ</span><code>' + esc(fmtCnpj(p[5])) + "</code></div>" +
      (precos || '<div class="ficha-linha"><span>Preços</span><strong>sem coleta recente</strong></div>') +
      '<div class="ficha-links"><a href="' + mapsLink([p[2], p[3], achado.m.nome, estado.uf, "Brasil"].filter(Boolean).join(", ")) + '" target="_blank" rel="noopener">Abrir endereço no Google Maps</a></div>' +
      '<div class="nota">O ponto no mapa é o centro do município, não a posição do posto.</div>';
    f.hidden = false;
    $("#fechar-ficha").addEventListener("click", fecharFicha);
  }

  // ------------------------------------------------------------------ busca
  var tBusca;
  function buscar() {
    var q = norm($("#entrada").value).trim(), box = $("#resultados");
    if (q.length < 2) { box.hidden = true; box.innerHTML = ""; return; }
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
        box.hidden = true; $("#entrada").value = "";
        selecionar(b.dataset.uf, b.dataset.ibge).then(function () { if (b.dataset.t === "p") abrirFichaPosto(b.dataset.cnpj); });
      });
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
    var abertas = ["combustível", "top 3", "encontrar", "resumo do filtro"];
    $$("#painel > .secao").forEach(function (s) {
      var h = s.querySelector(":scope > h2");
      if (!h || s.querySelector("#entrada")) return;
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

      renderProdutos(); renderTotais(); configurarPainel();
      $("#uf").addEventListener("change", function (e) { e.target.value ? selecionar(e.target.value, "") : limparSelecao(); });
      $("#mun").addEventListener("change", function (e) { selecionar(estado.uf, e.target.value); });
      $("#limpar").addEventListener("click", limparSelecao);
      $$("input[name=cor]").forEach(function (i) { i.addEventListener("change", function () { estado.cor = i.value; desenhar(); renderLegenda(); gravarHash(); }); });
      $("#entrada").addEventListener("input", function () { clearTimeout(tBusca); tBusca = setTimeout(buscar, 120); });
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
