"""Top 3 mais baratos e mais caros por combustível: Brasil, UF e município."""
from __future__ import annotations

import pandas as pd

from .tratar import ordem_produtos

CAMPOS = ["cnpj", "nome", "bandeira", "endereco", "bairro", "municipio_nome", "uf", "codigo_ibge", "preco", "data"]


def _linha(r: pd.Series) -> dict:
    return {
        "cnpj": r["cnpj"], "nome": r["nome"], "bandeira": r["bandeira"],
        "endereco": r["endereco"], "bairro": r["bairro"],
        "municipio": r["municipio_nome"], "uf": r["uf"],
        "ibge": None if pd.isna(r["codigo_ibge"]) else str(r["codigo_ibge"]),
        "preco": round(float(r["preco"]), 3), "data": r["data"].strftime("%Y-%m-%d"),
    }


def top3(df: pd.DataFrame, n: int = 3) -> dict[str, dict[str, list[dict]]]:
    """{produto: {"baratos": [...], "caros": [...]}} para os postos de `df`."""
    saida: dict[str, dict[str, list[dict]]] = {}
    if df.empty:
        return saida
    for produto in ordem_produtos(df["produto"].unique()):
        d = df[df["produto"] == produto]
        # empate de preço: coleta mais recente primeiro, depois nome (resultado estável)
        base = d.sort_values(["data", "nome"], ascending=[False, True])
        baratos = base.sort_values("preco", ascending=True, kind="stable").head(n)
        caros = base.sort_values("preco", ascending=False, kind="stable").head(n)
        saida[produto] = {
            "baratos": [_linha(r) for _, r in baratos.iterrows()],
            "caros": [_linha(r) for _, r in caros.iterrows()],
        }
    return saida


def ranking_por_escopo(precos: pd.DataFrame, n: int = 3):
    """Retorna (brasil, {uf: ranking}, {codigo_ibge: ranking}).

    Município sem código IBGE (grafia não casada) fica fora do ranking municipal,
    mas continua nos rankings da UF e do Brasil.
    """
    brasil = top3(precos, n)
    por_uf = {uf: top3(g, n) for uf, g in precos.groupby("uf")}
    com_cod = precos.dropna(subset=["codigo_ibge"])
    por_mun = {str(c): top3(g, n) for c, g in com_cod.groupby("codigo_ibge")}
    return brasil, por_uf, por_mun
