"""Coordenadas de cada posto, da API de Revendedores da ANP (revendedoresapi.anp.gov.br).

O endpoint /v1/combustivel devolve, por posto, Latitude/Longitude (e as versões ANP4C), a
validação geográfica e a acurácia estimada. Pagina em até 5.000 registros. O formato exato
da resposta não é garantido, então o leitor é tolerante: acha a lista de registros onde ela
estiver e casa as colunas pelo nome (sem acento, caixa ou pontuação).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pandas as pd
import requests

from .util import chave_texto, cnpj_chave, para_float

API = "https://revendedoresapi.anp.gov.br/v1/combustivel"
CABECALHO = {"User-Agent": "Mozilla/5.0 (compatible; anp-mapa/1.0; +https://github.com/RodrigoAiosa/anp)",
             "Accept": "application/json"}
MAX_PAGINAS = 60
# caixa que contém o Brasil (inclui ilhas oceânicas)
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = -34.0, 6.0, -74.5, -28.0


def achar_registros(obj) -> list[dict]:
    """Devolve a lista de registros (dicts), esteja a resposta numa lista ou dentro de um envelope."""
    if isinstance(obj, list):
        return [r for r in obj if isinstance(r, dict)]
    if isinstance(obj, dict):
        for v in obj.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
        for v in obj.values():
            if isinstance(v, dict):
                r = achar_registros(v)
                if r:
                    return r
    return []


def total_paginas(obj) -> int | None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if "PAGIN" in chave_texto(k) and "TOTAL" in chave_texto(k) and isinstance(v, (int, float, str)):
                try:
                    return int(v)
                except (TypeError, ValueError):
                    pass
        for v in obj.values():
            if isinstance(v, dict):
                t = total_paginas(v)
                if t:
                    return t
    return None


def coordenada_valida(lat, lon) -> bool:
    return (lat is not None and lon is not None and LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX
            and not (lat == 0 and lon == 0))


def _num(v):
    f = para_float(v)
    return f if f is not None and f == f else None


def escolher_coordenada(r: dict) -> tuple[float | None, float | None, str]:
    """(lat, lon, origem). Prefere Latitude/Longitude; cai para ANP4C; tenta trocar lat/lon invertidos."""
    k = {chave_texto(a): b for a, b in r.items()}
    pares = [("anp", _num(k.get("LATITUDE")), _num(k.get("LONGITUDE"))),
             ("anp4c", _num(k.get("LATITUDE ANP4C")), _num(k.get("LONGITUDE ANP4C")))]
    for origem, la, lo in pares:
        if coordenada_valida(la, lo):
            return la, lo, origem
        if la is not None and lo is not None and coordenada_valida(lo, la):  # invertidos
            return lo, la, origem + "-invertida"
    return None, None, ""


def registros_para_df(registros: list[dict]) -> pd.DataFrame:
    linhas = []
    for r in registros:
        k = {chave_texto(a): b for a, b in r.items()}
        lat, lon, origem = escolher_coordenada(r)
        linhas.append({
            "cnpj": cnpj_chave(k.get("CNPJ")), "lat": lat, "lon": lon, "origem": origem,
            "acuracia_m": _num(k.get("ESTIMATIVA DE ACURACIA M") or k.get("ESTIMATIVA DE ACURACIA")),
            "validacao": str(k.get("VALIDACAO") or ""),
        })
    return pd.DataFrame(linhas, columns=["cnpj", "lat", "lon", "origem", "acuracia_m", "validacao"])


def _get(url: str, params: dict, tentativas: int = 4):
    ultimo = None
    for t in range(1, tentativas + 1):
        try:
            r = requests.get(url, params=params, headers=CABECALHO, timeout=180)
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            ultimo = e
            print(f"  API ANP, tentativa {t}/{tentativas}: {e}", file=sys.stderr)
            time.sleep(4 * t)
    raise RuntimeError(f"API de revendedores indisponível: {ultimo}")


def baixar_coordenadas(pasta: Path) -> Path | None:
    """Percorre todas as páginas e grava `coordenadas.csv`. Retorna None se a API falhar
    (o mapa então cai para a posição no centro do município)."""
    pasta.mkdir(parents=True, exist_ok=True)
    print("Coordenadas (API de Revendedores da ANP):")
    todos: list[dict] = []
    vistos: set[str] = set()
    try:
        for n in range(1, MAX_PAGINAS + 1):
            obj = _get(API, {"numeropagina": n})
            regs = achar_registros(obj)
            if n == 1:
                tp = total_paginas(obj)
                chaves = sorted(regs[0].keys()) if regs else []
                print(f"  formato: {type(obj).__name__}; páginas informadas: {tp}; campos: {chaves}")
                if regs:
                    print("  exemplo:", json.dumps(regs[0], ensure_ascii=False)[:700])
            if not regs:
                break
            ass = json.dumps(regs[0], sort_keys=True) + str(len(regs))
            if ass in vistos:       # a API repetiu a página: acabou
                break
            vistos.add(ass)
            todos.extend(regs)
            print(f"  página {n}: {len(regs)} registros")
            if tp and n >= tp:
                break
    except Exception as e:  # noqa: BLE001
        print(f"  Sem coordenadas da API ({e}). O mapa usará o centro do município.", file=sys.stderr)
        return None
    if not todos:
        print("  A API não devolveu registros.", file=sys.stderr)
        return None
    df = registros_para_df(todos)
    ok = int(df["lat"].notna().sum())
    print(f"  {len(df)} registros, {ok} com coordenada válida ({100 * ok / max(1, len(df)):.0f}%)")
    destino = pasta / "coordenadas.csv"
    df.to_csv(destino, index=False)
    return destino
