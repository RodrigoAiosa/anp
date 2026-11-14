"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => n.toLocaleString("pt-BR");
  const fmtPreco = (v, prod) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + (prod && prod.startsWith("GLP") ? "" : "/L");
  const fmtData = (d) => (d ? d.split("-").reverse().join("/") : "");
  const fmtCnpj = (c) => (c && c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : c || "");
  const PAGINA = 100;

  let R = null;                 // resumo.json
  const cacheUF = {};           // uf -> json
  const marcadores = new Map(); // ibge -> circle
  let estado = { uf: "", ibge: "", prod: "", busca: "", mostrar: PAGINA };
  let mapa, camada;

  const map = L.map("mapa", { preferCanvas: true, zoomControl: true }).setView([-14.2, -51.9], 4);
  mapa = map;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: "© colaboradores do OpenStreetMap",
  }).addTo(map);
  camada = L.layerGroup().addTo(map);

  async function json(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " → " + r.status);
    return r.json();
  }
  async function carregarUF(uf) {
    if (!cacheUF[uf]) cacheUF[uf] = await json("dados/uf/" + uf + ".json");
    return cacheUF[uf];
  }

  function raio(n) { return Math.max(3, Math.min(22, 2.2 * Math.sqrt(n))); }
  function cor(n) { return n >= 200 ? "#ef4444" : n >= 50 ? "#f59e0b" : n >= 10 ? "#eab308" : "#38bdf8"; }

  function desenharMarcadores() {
    camada.clearLayers();
    marcadores.clear();
    for (const [ibge, nome, uf, lat, lon, n] of R.municipios) {
      if (estado.uf && uf !== estado.uf) continue;
      const c = L.circleMarker([lat, lon], { radius: raio(n), color: cor(n), weight: 1, fillOpacity: 0.55 });
      c.bindTooltip(esc(nome) + " – " + uf + "<br>" + fmtN(n) + " posto" + (n === 1 ? "" : "s"));
      c.on("click", () => selecionar(uf, ibge));
      c.addTo(camada);
      marcadores.set(ibge, c);
    }
  }

  async function selecionar(uf, ibge) {
    $("uf").value = uf;
    await onUF(uf, ibge || "");
  }

  function preencherMunicipios(dados, ibge) {
    const sel = $("mun");
    sel.innerHTML = '<option value="">Todos do estado</option>';
    for (const m of dados.municipios) {
      if (!m.ibge) continue;
      const o = document.createElement("option");
      o.value = m.ibge; o.textContent = m.nome + " (" + m.n + ")";
      sel.appendChild(o);
    }
    sel.disabled = false;
    sel.value = ibge || "";
  }

  async function onUF(uf, ibge) {
    estado.uf = uf; estado.ibge = ibge || ""; estado.busca = ""; estado.mostrar = PAGINA;
    $("busca").value = "";
    if (uf) {
      const dados = await carregarUF(uf);
      preencherMunicipios(dados, estado.ibge);
    } else {
      $("mun").innerHTML = '<option value="">Todos do estado</option>';
      $("mun").disabled = true;
    }
    desenharMarcadores();
    enquadrar();
    renderizar();
  }

  function enquadrar() {
    const pts = [];
    for (const [ibge, , uf, lat, lon] of R.municipios) {
      if (estado.ibge ? ibge === estado.ibge : (!estado.uf || uf === estado.uf)) pts.push([lat, lon]);
    }
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 11);
    else map.fitBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: 9 });
  }

  function escopoAtual() {
    const dados = estado.uf ? cacheUF[estado.uf] : null;
    if (estado.ibge && dados) {
      const m = dados.municipios.find((x) => x.ibge === estado.ibge);
      return { rotulo: m.nome + " – " + estado.uf, ranking: m.ranking, nivel: "município" };
    }
    if (dados) return { rotulo: R.ufs.find((u) => u.uf === estado.uf).nome, ranking: dados.ranking, nivel: "estado" };
    return { rotulo: "Brasil", ranking: R.ranking_br, nivel: "Brasil" };
  }

  function itemRank(e, i) {
    const loc = [e.endereco, e.bairro].filter(Boolean).join(" – ");
    return '<div class="item" data-uf="' + esc(e.uf) + '" data-ibge="' + esc(e.ibge) + '">' +
      '<span class="pos">' + (i + 1) + "</span>" +
      "<div><b>" + esc(e.nome || "(sem nome)") + '</b><div class="sub">' + esc(e.bandeira) + " · " + esc(loc) + "<br>" +
      esc(e.municipio) + "/" + esc(e.uf) + " · coleta " + fmtData(e.data) + "</div></div>" +
      '<span class="preco">' + fmtPreco(e.preco, estado.prod) + "</span></div>";
  }

  function renderRanking() {
    const esc_ = escopoAtual();
    $("tit-rank").textContent = "Top 3 — " + estado.prod + " — " + esc_.rotulo;
    const r = esc_.ranking && esc_.ranking[estado.prod];
    if (!r) {
      $("rank").innerHTML = '<div class="vazio">Sem preço coletado de ' + esc(estado.prod) + " em " + esc(esc_.rotulo) +
        " nos últimos " + R.janela_dias + " dias de coleta." + (esc_.nivel === "município" ? " Tente escolher o estado inteiro." : "") + "</div>";
      return;
    }
    const bloco = (cls, titulo, lista) => '<div class="grupo ' + cls + '"><h3>' + titulo + "</h3>" +
      lista.map(itemRank).join("") + "</div>";
    $("rank").innerHTML = bloco("bar", "▼ 3 mais baratos", r.baratos) + bloco("car", "▲ 3 mais caros", r.caros) +
      (r.baratos.length < 3 ? '<div class="vazio">Menos de 3 postos com preço neste escopo.</div>' : "");
    $("rank").querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => {
      if (el.dataset.ibge) selecionar(el.dataset.uf, el.dataset.ibge);
    }));
  }

  function postosDoEscopo() {
    if (!estado.uf) return null;
    const dados = cacheUF[estado.uf];
    const muns = estado.ibge ? dados.municipios.filter((m) => m.ibge === estado.ibge) : dados.municipios;
    const saida = [];
    for (const m of muns) for (const p of m.postos) saida.push({ m: m.nome, p });
    return saida;
  }

  function renderTotais() {
    let nPostos, nPreco;
    if (estado.ibge) {
      const m = cacheUF[estado.uf].municipios.find((x) => x.ibge === estado.ibge);
      nPostos = m.n; nPreco = m.postos.filter((p) => Object.keys(p[6]).length).length;
    } else if (estado.uf) {
      const u = R.ufs.find((x) => x.uf === estado.uf);
      nPostos = u.n; nPreco = u.n_precos;
    } else { nPostos = R.n_postos; nPreco = R.n_postos_com_preco; }
    const nMun = estado.ibge ? 1 : R.municipios.filter((m) => !estado.uf || m[2] === estado.uf).length;
    $("totais").innerHTML = "<div><b>" + fmtN(nPostos) + "</b><span>postos</span></div>" +
      "<div><b>" + fmtN(nMun) + "</b><span>municípios</span></div>" +
      "<div><b>" + fmtN(nPreco) + "</b><span>com preço recente</span></div>";
  }

  function renderLista() {
    const base = postosDoEscopo();
    const ul = $("lista");
    $("busca").disabled = !base;
    if (!base) {
      ul.innerHTML = ""; $("mais").hidden = true;
      $("lista-info").textContent = "Escolha um estado (ou clique em um município no mapa) para listar os postos.";
      return;
    }
    const q = estado.busca.trim().toLowerCase();
    const filtrados = q ? base.filter(({ m, p }) => (m + " " + p[0] + " " + p[1] + " " + p[2] + " " + p[3] + " " + p[5]).toLowerCase().includes(q)) : base;
    const fatia = filtrados.slice(0, estado.mostrar);
    $("lista-info").textContent = fmtN(filtrados.length) + " posto" + (filtrados.length === 1 ? "" : "s") + (q ? " encontrados" : "");
    ul.innerHTML = fatia.map(({ m, p }) => {
      const precos = Object.entries(p[6]).map(([prod, v]) => '<span class="tag p">' + esc(prod) + " " + fmtPreco(v[0], prod).replace("/L", "") + "</span>").join("");
      return '<li><div class="nome">' + esc(p[0]) + '</div><div class="sub">' + esc(p[1]) + " · " + esc(p[2]) +
        (p[3] ? " – " + esc(p[3]) : "") + (p[4] ? " · CEP " + esc(p[4]) : "") + "<br>" + esc(m) + " · CNPJ " + esc(fmtCnpj(p[5])) +
        "</div>" + precos + "</li>";
    }).join("");
    $("mais").hidden = filtrados.length <= fatia.length;
  }

  function renderizar() { renderTotais(); renderRanking(); renderLista(); }

  async function iniciar() {
    R = await json("dados/resumo.json");
    if (R.demo) $("demo").hidden = false;
    $("atualizado").textContent = "Gerado em " + R.gerado_em + (R.periodo_precos ? " · preços de " + fmtData(R.periodo_precos[0]) + " a " + fmtData(R.periodo_precos[1]) : "") + ".";
    for (const u of R.ufs) {
      const o = document.createElement("option");
      o.value = u.uf; o.textContent = u.nome + " (" + fmtN(u.n) + ")";
      $("uf").appendChild(o);
    }
    for (const p of R.produtos) {
      const o = document.createElement("option"); o.value = p; o.textContent = p; $("prod").appendChild(o);
    }
    estado.prod = R.produtos[0] || "";
    $("uf").addEventListener("change", (e) => onUF(e.target.value, ""));
    $("mun").addEventListener("change", (e) => { estado.ibge = e.target.value; estado.mostrar = PAGINA; enquadrar(); renderizar(); });
    $("prod").addEventListener("change", (e) => { estado.prod = e.target.value; renderRanking(); });
    $("busca").addEventListener("input", (e) => { estado.busca = e.target.value; estado.mostrar = PAGINA; renderLista(); });
    $("mais").addEventListener("click", () => { estado.mostrar += PAGINA; renderLista(); });
    desenharMarcadores();
    renderizar();
  }

  iniciar().catch((e) => {
    $("painel").insertAdjacentHTML("afterbegin", '<p class="vazio">Não foi possível carregar os dados: ' + esc(e.message) + "</p>");
  });
})();
