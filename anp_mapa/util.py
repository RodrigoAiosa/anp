"""Funções pequenas de normalização de texto e números."""
from __future__ import annotations

import re
import unicodedata

UF_POR_CODIGO = {
    11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO",
    21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL",
    28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR",
    42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF",
}

NOME_UF = {
    "AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas", "BA": "Bahia",
    "CE": "Ceará", "DF": "Distrito Federal", "ES": "Espírito Santo", "GO": "Goiás",
    "MA": "Maranhão", "MT": "Mato Grosso", "MS": "Mato Grosso do Sul",
    "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba", "PR": "Paraná",
    "PE": "Pernambuco", "PI": "Piauí", "RJ": "Rio de Janeiro",
    "RN": "Rio Grande do Norte", "RS": "Rio Grande do Sul", "RO": "Rondônia",
    "RR": "Roraima", "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe",
    "TO": "Tocantins",
}


def sem_acento(texto: object) -> str:
    s = "" if texto is None else str(texto)
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def chave_texto(texto: object) -> str:
    """MAIÚSCULAS, sem acento, sem pontuação e sem espaços repetidos."""
    s = sem_acento(texto).upper()
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def so_digitos(texto: object) -> str:
    return re.sub(r"\D", "", "" if texto is None else str(texto))


def cnpj_chave(texto: object) -> str:
    """CNPJ só com dígitos, completado com zeros à esquerda (14)."""
    d = so_digitos(texto)
    return d.zfill(14) if d else ""


def para_float(valor: object) -> float | None:
    """'6,199' -> 6.199. Retorna None se não der para ler."""
    if valor is None:
        return None
    s = str(valor).strip().replace("R$", "").replace(" ", "")
    if not s:
        return None
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None
