"""Coordenadas por município (centroide do IBGE).

A ANP não publica latitude/longitude de cada posto nestes arquivos; o mapa
posiciona os postos no município e lista cada um no painel.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from .util import UF_POR_CODIGO, chave_texto

MUNICIPIOS_CSV = Path(__file__).resolve().parent.parent / "data" / "municipios.csv"


def carregar_municipios(caminho: Path = MUNICIPIOS_CSV) -> pd.DataFrame:
    m = pd.read_csv(caminho, dtype={"codigo_ibge": str})
    m["uf"] = m["codigo_uf"].map(UF_POR_CODIGO)
    m["chave"] = m["uf"] + "|" + m["nome"].map(chave_texto)
    return m[["codigo_ibge", "nome", "uf", "latitude", "longitude", "chave"]]


# Grafias antigas/alternativas que a ANP usa e o IBGE grafa de outro modo.
# Quem não casar aparece em `nao_casados.csv` após o build: acrescente aqui.
ALIAS = {
    "SP|SAO LUIS DO PARAITINGA": "SP|SAO LUIZ DO PARAITINGA",
    "RN|ASSU": "RN|ACU",
    "PB|CAMPO DE SANTANA": "PB|TACIMA",
    "MG|BRASOPOLIS": "MG|BRAZOPOLIS",
    "SC|PICARRAS": "SC|BALNEARIO PICARRAS",
    # encontrados no primeiro build real (cadastro da ANP de nov/2026)
    "RS|SANTANA DO LIVRAMENTO": "RS|SANT ANA DO LIVRAMENTO",
    "PA|SANTA ISABEL DO PARA": "PA|SANTA IZABEL DO PARA",
    "PE|SAO CAITANO": "PE|SAO CAETANO",
    "RO|ESPIGAO DO OESTE": "RO|ESPIGAO D OESTE",
    "GO|BOM JESUS": "GO|BOM JESUS DE GOIAS",
    "MG|DONA EUZEBIA": "MG|DONA EUSEBIA",
    "RN|BOA SAUDE": "RN|JANUARIO CICCO BOA SAUDE",
    "SE|GRACCHO CARDOSO": "SE|GRACHO CARDOSO",
    "RN|CAMPO GRANDE": "RN|AUGUSTO SEVERO CAMPO GRANDE",
    "TO|COUTO DE MAGALHAES": "TO|COUTO MAGALHAES",
    "RN|AREZ": "RN|ARES",
}


def casar_municipio(df: pd.DataFrame, municipios: pd.DataFrame) -> pd.DataFrame:
    """Acrescenta `codigo_ibge`, `lat`, `lon` e `municipio_nome` oficial (colunas de entrada: uf, municipio)."""
    d = df.copy()
    chave = (d["uf"] + "|" + d["municipio"].map(chave_texto)).map(lambda k: ALIAS.get(k, k))
    base = municipios.set_index("chave")
    d["codigo_ibge"] = chave.map(base["codigo_ibge"])
    d["lat"] = chave.map(base["latitude"])
    d["lon"] = chave.map(base["longitude"])
    d["municipio_nome"] = chave.map(base["nome"]).fillna(d["municipio"].str.title())
    return d
