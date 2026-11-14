"""Monta o site estático (public/) a partir do cadastro e dos preços da ANP."""
from __future__ import annotations

import datetime as dt
import json
import shutil
from pathlib import Path

import pandas as pd

from .geo import carregar_municipios, casar_municipio
from .ranking import ranking_por_escopo
from .tratar import ler_cadastro, ler_precos, ordem_produtos, precos_recentes
from .util import NOME_UF

RAIZ = Path(__file__).resolve().parent.parent
APP = RAIZ / "app"


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
                marcadores.append([str(cod), nome, uf, round(float(lat), 4), round(float(lon), 4), len(lista)])
        muns.sort(key=lambda m: m["nome"])
        _dump({"uf": uf, "municipios": muns, "ranking": por_uf.get(uf, {})}, saida / "dados" / "uf" / f"{uf}.json")
        com_preco = int(g["cnpj"].isin(mapa_preco).sum())
        resumo_ufs.append({"uf": uf, "nome": NOME_UF.get(uf, uf), "n": len(g), "n_precos": com_preco})

    sem_coord = postos[postos["codigo_ibge"].isna()]
    if len(sem_coord):
        (sem_coord.groupby(["uf", "municipio"]).size().rename("postos").reset_index()
         .sort_values("postos", ascending=False)
         .to_csv(saida / "dados" / "nao_casados.csv", index=False))

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
    }
    _dump(resumo, saida / "dados" / "resumo.json")
    return resumo
