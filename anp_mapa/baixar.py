"""Download dos arquivos abertos da ANP.

Atenção: o portal gov.br pode recusar downloads de alguns provedores de nuvem.
Se isso acontecer, baixe os arquivos manualmente e use `--cadastro` e `--precos`.
"""
from __future__ import annotations

import datetime as dt
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


def baixar_precos(pasta: Path, quantos: int = 2, hoje: dt.date | None = None) -> list[Path]:
    """Baixa os `quantos` semestres mais recentes que existirem (o semestre corrente costuma
    ainda não estar publicado: nesse caso recua)."""
    achados: list[Path] = []
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
