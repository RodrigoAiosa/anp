"""Monta o site estático (public/) a partir do cadastro e dos preços da ANP."""
from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import shutil
from pathlib import Path

import pandas as pd

from .geo import carregar_municipios, casar_municipio
from .ranking import ranking_por_escopo
from .tratar import ler_cadastro, ler_precos, ordem_produtos, precos_recentes
from .util import NOME_UF

RAIZ = Path(__file__).resolve().parent.parent
APP = RAIZ / "app"
EXTRA = RAIZ / "public_extra"
TITULO = "Mapa de Postos de Combustíveis — ANP"
DESCRICAO = ("Todos os postos de combustíveis cadastrados na ANP, por estado e município, "
             "com os 3 mais baratos e os 3 mais caros de cada combustível.")


def _dump(obj, caminho: Path) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def construir(cadastro: Path, precos: list[Path], saida: Path, dias: int = 30,
              demo: bool = False, ufs: list[str] | None = None) -> dict:
    """Gera o site em `saida` e devolve o resumo (também gravado em dados/resumo.json)."""
    municipios = carregar_municipios()
    postos = ler_cadastro(cadastro)
    if ufs:
        postos = postos[postos["uf"].isin(ufs)]
    postos = casar_municipio(postos, municipios)

    if precos:
        todos = ler_precos(precos)
        if ufs:
            todos = todos[todos["uf"].isin(ufs)]
        rec = precos_recentes(todos, dias)
        rec = casar_municipio(rec, municipios)
        # preencher bandeira/endereço vazios da coleta com o cadastro, quando houver
        cad = postos.set_index("cnpj")
        for col_p, col_c in (("bandeira", "bandeira"), ("endereco", "endereco"), ("bairro", "bairro")):
            vazio = rec[col_p].fillna("").eq("")
            rec.loc[vazio, col_p] = rec.loc[vazio, "cnpj"].map(cad[col_c]).fillna("")
        periodo = [rec["data"].min().strftime("%Y-%m-%d"), rec["data"].max().strftime("%Y-%m-%d")]
    else:
        rec = pd.DataFrame(columns=["cnpj", "produto", "preco", "data", "uf", "codigo_ibge"])
        periodo = None

    brasil, por_uf, por_mun = ranking_por_escopo(rec) if len(rec) else ({}, {}, {})
    medias: dict[str, dict[str, list]] = {}
    if len(rec):
        agg = rec.dropna(subset=["codigo_ibge"]).groupby(["codigo_ibge", "produto"])["preco"].agg(["mean", "count"])
        for (cod, prod), r in agg.iterrows():
            medias.setdefault(str(cod), {})[prod] = [round(float(r["mean"]), 3), int(r["count"])]
    mapa_preco = {}
    for r in rec.itertuples():
        mapa_preco.setdefault(r.cnpj, {})[r.produto] = [round(float(r.preco), 3), r.data.strftime("%Y-%m-%d")]

    if saida.exists():
        shutil.rmtree(saida)
    saida.mkdir(parents=True)
    for item in APP.iterdir():
        (shutil.copytree if item.is_dir() else shutil.copy2)(item, saida / item.name)

    # ---- um arquivo por UF (postos + ranking dos municípios) ----
    resumo_ufs, marcadores = [], []
    for uf, g in postos.groupby("uf"):
        muns = []
        for (cod, nome, lat, lon), gm in g.groupby(["codigo_ibge", "municipio_nome", "lat", "lon"], dropna=False):
            lista = [
                [r.razao, r.bandeira, ", ".join(x for x in (r.endereco, r.complemento) if x),
                 r.bairro, r.cep, r.cnpj, mapa_preco.get(r.cnpj, {})]
                for r in gm.sort_values("razao").itertuples()
            ]
            tem = pd.notna(cod)
            muns.append({
                "ibge": str(cod) if tem else None, "nome": nome,
                "lat": float(lat) if tem else None, "lon": float(lon) if tem else None,
                "n": len(lista), "ranking": por_mun.get(str(cod), {}) if tem else {},
                "postos": lista,
            })
            if tem:
                marcadores.append([str(cod), nome, uf, round(float(lat), 4), round(float(lon), 4), len(lista),
                                   medias.get(str(cod), {})])
        muns.sort(key=lambda m: m["nome"])
        _dump({"uf": uf, "municipios": muns, "ranking": por_uf.get(uf, {})}, saida / "dados" / "uf" / f"{uf}.json")
        com_preco = int(g["cnpj"].isin(mapa_preco).sum())
        resumo_ufs.append({"uf": uf, "nome": NOME_UF.get(uf, uf), "n": len(g), "n_precos": com_preco})

    sem_coord = postos[postos["codigo_ibge"].isna()]
    if len(sem_coord):
        (sem_coord.groupby(["uf", "municipio"]).size().rename("postos").reset_index()
         .sort_values("postos", ascending=False)
         .to_csv(saida / "dados" / "nao_casados.csv", index=False))

    if len(postos) == 0:
        raise SystemExit("ERRO: nenhum posto lido do cadastro. Nada será publicado.")
    if sum(u["n"] for u in resumo_ufs) != len(postos):
        raise SystemExit("ERRO: a soma dos postos por UF não fecha com o cadastro. Nada será publicado.")
    bandeiras = postos["bandeira"].str.upper().value_counts()
    resumo = {
        "gerado_em": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "demo": demo,
        "fonte": "ANP — Dados Cadastrais dos Revendedores Varejistas e Levantamento de Preços de Combustíveis (LPC)",
        "n_postos": int(len(postos)),
        "n_postos_com_preco": int(postos["cnpj"].isin(mapa_preco).sum()),
        "n_sem_coordenada": int(len(sem_coord)),
        "periodo_precos": periodo, "janela_dias": dias,
        "produtos": ordem_produtos(rec["produto"].unique()) if len(rec) else [],
        "ufs": sorted(resumo_ufs, key=lambda x: x["uf"]),
        "ranking_br": brasil, "municipios": marcadores,
        "bandeiras": [[k, int(v)] for k, v in bandeiras.items()],
    }
    _dump(resumo, saida / "dados" / "resumo.json")
    _publicar_extras(saida, resumo, ufs)
    return resumo


def url_do_site() -> str:
    explicita = os.environ.get("SITE_URL", "").strip().rstrip("/")
    if explicita:
        return explicita if explicita.startswith("http") else "https://" + explicita
    producao = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL", "").strip()
    return ("https://" + producao) if producao else ""


def _cabecalho_seo(base: str) -> str:
    t, d = html.escape(TITULO, quote=True), html.escape(DESCRICAO, quote=True)
    linhas = [
        '<meta name="theme-color" content="#0b0f14">',
        '<meta name="color-scheme" content="dark light">',
        '<meta name="referrer" content="strict-origin-when-cross-origin">',
        '<link rel="manifest" href="/manifest.webmanifest">',
        '<link rel="apple-touch-icon" href="/icon.svg">',
        '<meta property="og:type" content="website">', '<meta property="og:locale" content="pt_BR">',
        f'<meta property="og:title" content="{t}">', f'<meta property="og:description" content="{d}">',
        '<meta name="twitter:card" content="summary">',
        f'<meta name="twitter:title" content="{t}">', f'<meta name="twitter:description" content="{d}">',
        '<script>if("serviceWorker"in navigator&&(location.protocol==="https:"||location.hostname==="localhost"))'
        '{addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})}</script>',
    ]
    if base:
        linhas += [f'<link rel="canonical" href="{base}/">', f'<meta property="og:url" content="{base}/">',
                   f'<meta property="og:image" content="{base}/icon.svg">']
    return "\n".join(linhas) + "\n"


def _publicar_extras(saida: Path, resumo: dict, ufs: list[str] | None) -> None:
    """SEO/PWA no index.html e arquivos de public_extra/ (404, sobre, manifest, sw, robots, ícone)."""
    base = url_do_site()
    idx = saida / "index.html"
    conteudo = idx.read_text(encoding="utf-8")
    ancora = re.search(r'<meta name="description"[^>]*>\n?', conteudo)
    if not ancora:
        raise SystemExit('ERRO: <meta name="description"> não encontrado em app/index.html.')
    idx.write_text(conteudo[:ancora.end()] + _cabecalho_seo(base) + conteudo[ancora.end():], encoding="utf-8")

    versao = (os.environ.get("VERCEL_GIT_COMMIT_SHA", "")[:7] or "local") + "-" + \
        dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M")
    per = resumo["periodo_precos"]
    subst = {
        "{{SITE_URL}}": base, "{{VERSAO}}": versao, "{{GERADO}}": html.escape(resumo["gerado_em"]),
        "{{N_POSTOS}}": f"{resumo['n_postos']:,}".replace(",", "."),
        "{{PERIODO}}": f"{per[0]} a {per[1]}" if per else "indisponível",
    }
    for modelo in sorted(EXTRA.iterdir()):
        txt = modelo.read_text(encoding="utf-8")
        for k, v in subst.items():
            txt = txt.replace(k, v)
        (saida / modelo.name).write_text(txt, encoding="utf-8")

    urls = [f"{base}/", f"{base}/sobre"] if base else []
    (saida / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + "".join(f"<url><loc>{u}</loc></url>" for u in urls) + "</urlset>\n", encoding="utf-8")
    if base:
        with open(saida / "robots.txt", "a", encoding="utf-8") as f:
            f.write(f"Sitemap: {base}/sitemap.xml\n")
    _dump({
        "projeto": TITULO, "gerado_em_utc": resumo["gerado_em"], "recorte_uf": ufs or None,
        "postos": resumo["n_postos"], "postos_com_preco": resumo["n_postos_com_preco"],
        "sem_coordenada": resumo["n_sem_coordenada"], "periodo_precos": per,
        "commit": os.environ.get("VERCEL_GIT_COMMIT_SHA"), "demo": resumo["demo"],
    }, saida / "status.json")
