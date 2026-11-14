"""Download dos arquivos abertos da ANP.

Atenção: o portal gov.br pode recusar downloads de alguns provedores de nuvem.
Se isso acontecer, baixe os arquivos manualmente e use `--cadastro` e `--precos`.
"""
from __future__ import annotations

import datetime as dt
import sys
import time
from pathlib import Path

import requests

BASE = "https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos"
URL_CADASTRO = (
    f"{BASE}/arquivos-dados-cadastrais-dos-revendedores-varejistas-de-combustiveis-automotivos/"
    "dados-cadastrais-revendedores-varejistas-combustiveis-automoveis.csv"
)
# Série histórica de preços (LPC), um arquivo por semestre: ca-AAAA-01.csv / ca-AAAA-02.csv
URL_PRECOS = BASE + "/shpc/dsas/ca/ca-{ano}-{sem:02d}.csv"

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


def baixar_tudo(pasta: Path, semestres: int = 2) -> tuple[Path, list[Path]]:
    pasta.mkdir(parents=True, exist_ok=True)
    print("Cadastro de postos:")
    cadastro = pasta / "cadastro.csv"
    if not baixar(URL_CADASTRO, cadastro):
        raise RuntimeError("Arquivo de cadastro da ANP não encontrado.")
    print("Preços (LPC):")
    precos = []
    for ano, sem in semestres_recentes(quantos=semestres):
        destino = pasta / f"precos-{ano}-{sem:02d}.csv"
        if baixar(URL_PRECOS.format(ano=ano, sem=sem), destino):
            precos.append(destino)
    if not precos:
        print("  Nenhum arquivo de preços baixado: o mapa sairá sem o ranking.", file=sys.stderr)
    return cadastro, precos
