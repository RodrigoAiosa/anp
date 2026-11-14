"""Download dos arquivos abertos da ANP.

Atenção: o portal gov.br pode recusar downloads de alguns provedores de nuvem.
Se isso acontecer, baixe os arquivos manualmente e use `--cadastro` e `--precos`.
"""
from __future__ import annotations

import datetime as dt
import re
import sys
import time
import zipfile
from pathlib import Path

import requests

BASE = "https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos"
URL_CADASTRO = (
    f"{BASE}/arquivos-dados-cadastrais-dos-revendedores-varejistas-de-combustiveis-automotivos/"
    "dados-cadastrais-revendedores-varejistas-combustiveis-automoveis.csv"
)
# Série histórica de preços (LPC), um arquivo por semestre. Os semestres recentes saem em .zip
# (ca-2026-01.zip, com o CSV dentro); os antigos em .csv. Tenta o .zip e depois o .csv.
URL_PRECOS = BASE + "/shpc/dsas/ca/ca-{ano}-{sem:02d}.{ext}"

# Desde 2023 a ANP publica um arquivo por MÊS e por grupo de produtos (não mais por semestre):
#   .../shpc/dsan/AAAA/precos-gasolina-etanol-MM.csv, precos-diesel-gnv-MM.csv e precos-glp-MM.csv
URL_MENSAL = BASE + "/shpc/dsan/{ano}/precos-{grupo}-{mes:02d}.csv"
GRUPOS_MENSAIS = ("gasolina-etanol", "diesel-gnv", "glp")
PAGINA_SERIE = "https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/serie-historica-de-precos-de-combustiveis"
_RE_MENSAL = re.compile(r"/shpc/dsan/(\d{4})/([^/?#\"']+)$", re.I)

CABECALHO = {"User-Agent": "Mozilla/5.0 (compatible; anp-mapa/1.0; +https://github.com/RodrigoAiosa/anp)"}


def semestres_recentes(hoje: dt.date | None = None, quantos: int = 2) -> list[tuple[int, int]]:
    hoje = hoje or dt.date.today()
    ano, sem = hoje.year, 1 if hoje.month <= 6 else 2
    saida = []
    for _ in range(quantos):
        saida.append((ano, sem))
        sem -= 1
        if sem == 0:
            ano, sem = ano - 1, 2
    return saida


def baixar(url: str, destino: Path, tentativas: int = 3) -> bool:
    """Baixa `url` para `destino`. Retorna False em 404 (arquivo ainda não existe)."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    for t in range(1, tentativas + 1):
        try:
            with requests.get(url, headers=CABECALHO, stream=True, timeout=120) as r:
                if r.status_code == 404:
                    print(f"  (não encontrado) {url}", file=sys.stderr)
                    return False
                r.raise_for_status()
                tmp = destino.with_suffix(destino.suffix + ".part")
                with open(tmp, "wb") as f:
                    for bloco in r.iter_content(1 << 20):
                        f.write(bloco)
                tmp.replace(destino)
                print(f"  ok {destino.name} ({destino.stat().st_size / 1e6:.1f} MB)")
                return True
        except requests.RequestException as e:
            print(f"  tentativa {t}/{tentativas} falhou: {e}", file=sys.stderr)
            time.sleep(3 * t)
    raise RuntimeError(f"Não foi possível baixar {url}")


def extrair_csv(arquivo_zip: Path, destino: Path) -> Path:
    """Extrai o (único) CSV de dentro do zip da ANP para `destino`."""
    with zipfile.ZipFile(arquivo_zip) as z:
        membros = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if not membros:
            raise RuntimeError(f"{arquivo_zip.name}: não há CSV dentro do zip.")
        with z.open(membros[0]) as src, open(destino, "wb") as dst:
            while True:
                bloco = src.read(1 << 20)
                if not bloco:
                    break
                dst.write(bloco)
    arquivo_zip.unlink()
    return destino


def meses_recentes(hoje: dt.date | None = None, quantos: int = 4) -> list[tuple[int, int]]:
    """(ano, mês) do corrente para trás."""
    hoje = hoje or dt.date.today()
    ano, mes = hoje.year, hoje.month
    saida = []
    for _ in range(quantos):
        saida.append((ano, mes))
        mes -= 1
        if mes == 0:
            ano, mes = ano - 1, 12
    return saida


def descobrir_mensais(html: str) -> dict[tuple[int, int], dict[str, str]]:
    """Lê da página da ANP os links dos arquivos mensais: {(ano, mês): {grupo: url}}."""
    achados: dict[tuple[int, int], dict[str, str]] = {}
    for href in sorted(set(re.findall(r'href="([^"]+)"', html))):
        m = _RE_MENSAL.search(href)
        if not m:
            continue
        ano, nome = int(m.group(1)), m.group(2).lower()
        grupo = next((g for g in GRUPOS_MENSAIS if g in nome), None)   # os nomes mudam de mês a mês
        mm = re.match(r"(?:precos-)?(\d{2})-", nome) or re.search(r"-(\d{2})(?:\.csv)?$", nome)
        if not grupo or not mm or not 1 <= int(mm.group(1)) <= 12:
            continue
        url = href if href.startswith("http") else "https://www.gov.br" + href if href.startswith("/") else href
        achados.setdefault((ano, int(mm.group(1))), {})[grupo] = url
    return achados


def baixar_precos_mensais(pasta: Path, meses: int = 3, hoje: dt.date | None = None) -> list[Path]:
    """Baixa os `meses` mais recentes publicados (todos os grupos de produtos de cada mês).
    Usa os links da página da ANP; se a página não responder, tenta o padrão de nome conhecido."""
    links: dict[tuple[int, int], dict[str, str]] = {}
    try:
        r = requests.get(PAGINA_SERIE, headers=CABECALHO, timeout=60)
        r.raise_for_status()
        links = descobrir_mensais(r.text)
    except requests.RequestException as e:
        print(f"  (página da ANP indisponível: {e}; uso o padrão de nome dos arquivos)", file=sys.stderr)
    if links:
        alvo = sorted(links, reverse=True)[:meses]
    else:
        alvo = meses_recentes(hoje, meses + 2)   # o mês corrente ainda pode não existir: sobra margem
        links = {ym: {g: URL_MENSAL.format(ano=ym[0], mes=ym[1], grupo=g) for g in GRUPOS_MENSAIS} for ym in alvo}
    achados: list[Path] = []
    meses_ok = 0
    for ym in alvo:
        if meses_ok >= meses:
            break
        ok_mes = False
        for grupo, url in sorted(links[ym].items()):
            destino = pasta / f"precos-{ym[0]}-{ym[1]:02d}-{grupo}.csv"
            if baixar(url, destino):
                achados.append(destino)
                ok_mes = True
        meses_ok += ok_mes
    return achados


def baixar_precos(pasta: Path, quantos: int = 2, hoje: dt.date | None = None, meses: int = 3) -> list[Path]:
    """Preços LPC: arquivos mensais (2023+). Se não houver nenhum, recua para os `quantos` semestres antigos que existirem (o semestre corrente costuma
    ainda não estar publicado: nesse caso recua)."""
    import os
    achados: list[Path] = baixar_precos_mensais(pasta, int(os.environ.get("MESES", meses)), hoje)
    if achados:
        return achados
    print("  Nenhum arquivo mensal encontrado: tentando os semestrais (até 2022).", file=sys.stderr)
    for ano, sem in semestres_recentes(hoje, quantos=quantos + 3):
        if len(achados) >= quantos:
            break
        csv_ = pasta / f"precos-{ano}-{sem:02d}.csv"
        if baixar(URL_PRECOS.format(ano=ano, sem=sem, ext="zip"), pasta / f"precos-{ano}-{sem:02d}.zip"):
            achados.append(extrair_csv(pasta / f"precos-{ano}-{sem:02d}.zip", csv_))
        elif baixar(URL_PRECOS.format(ano=ano, sem=sem, ext="csv"), csv_):
            achados.append(csv_)
    return achados


def baixar_tudo(pasta: Path, semestres: int = 2) -> tuple[Path, list[Path]]:
    pasta.mkdir(parents=True, exist_ok=True)
    print("Cadastro de postos:")
    cadastro = pasta / "cadastro.csv"
    if not baixar(URL_CADASTRO, cadastro):
        raise RuntimeError("Arquivo de cadastro da ANP não encontrado.")
    print("Preços (LPC):")
    precos = baixar_precos(pasta, semestres)
    if not precos:
        print("  Nenhum arquivo de preços baixado: o mapa sairá sem o ranking.", file=sys.stderr)
    return cadastro, precos
