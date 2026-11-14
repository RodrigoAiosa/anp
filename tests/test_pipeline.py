"""Testes offline (dados inventados). Rodar: python -m pytest -q"""
import json
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from anp_mapa import demo, geo, ranking, tratar
from anp_mapa.baixar import semestres_recentes
from anp_mapa.construir import construir
from anp_mapa.util import chave_texto, cnpj_chave, para_float


def test_utilitarios():
    assert chave_texto("  São  Luís-do Maranhão ") == "SAO LUIS DO MARANHAO"
    assert cnpj_chave("49.051.667/0001-12") == "49051667000112"
    assert cnpj_chave("1234") == "00000000001234"
    assert para_float("6,199") == 6.199
    assert para_float("1.234,5") == 1234.5
    assert para_float("") is None and para_float("abc") is None


def test_semestres_recentes():
    import datetime as dt
    assert semestres_recentes(dt.date(2026, 11, 14), 2) == [(2026, 2), (2026, 1)]
    assert semestres_recentes(dt.date(2026, 2, 1), 3) == [(2026, 1), (2025, 2), (2025, 1)]


def test_cadastro_com_cabecalho_latin1_e_duplicado(tmp_path):
    p = tmp_path / "c.csv"
    linhas = [
        "CÓDIGO SIMP;AUTORIZAÇÃO;DATA PUBLICAÇÃO;RAZÃO SOCIAL;CNPJ;ENDEREÇO;COMPLEMENTO;BAIRRO;CEP;UF;MUNICÍPIO;BANDEIRA;DATA VINCULAÇÃO",
        "1;PR/SP1;01/01/2020;POSTO A LTDA;11222333000144;RUA A, 1;;CENTRO;01001000;SP;SÃO PAULO;VIBRA;01/01/2020",
        "2;PR/SP2;01/01/2021;POSTO A NOVO LTDA;11222333000144;RUA A, 1;;CENTRO;01001000;SP;SÃO PAULO;IPIRANGA;01/01/2021",
        "3;PR/RS3;01/01/2021;POSTO B;22333444000155;RUA B, 2;;;90000000;RS;PORTO ALEGRE;;01/01/2021",
    ]
    p.write_bytes("\n".join(linhas).encode("latin-1"))
    df = tratar.ler_cadastro(p)
    assert len(df) == 2                                   # CNPJ repetido: fica a última linha
    assert df.loc[df.cnpj == "11222333000144", "bandeira"].item() == "IPIRANGA"
    assert df.loc[df.cnpj == "22333444000155", "bandeira"].item() == "BANDEIRA BRANCA"
    assert set(df.uf) == {"SP", "RS"}


def test_cadastro_sem_cabecalho(tmp_path):
    p = tmp_path / "c.csv"
    p.write_text("1;PR/PE1;14/09/2016;POSTO X LTDA;21240238000164;AVENIDA V, 410;LETRA A;CENTRO;56930000;PE;CALUMBI;BANDEIRA BRANCA;14/09/2016\n", encoding="utf-8")
    df = tratar.ler_cadastro(p)
    assert df.iloc[0]["municipio"] == "CALUMBI" and df.iloc[0]["cep"] == "56930000"


def _csv_precos(tmp_path, linhas):
    cab = "Regiao - Sigla;Estado - Sigla;Municipio;Revenda;CNPJ da Revenda;Nome da Rua;Numero Rua;Complemento;Bairro;Cep;Produto;Data da Coleta;Valor de Venda;Valor de Compra;Unidade de Medida;Bandeira"
    p = tmp_path / "p.csv"
    p.write_text("\n".join([cab] + linhas), encoding="utf-8")
    return p


def test_precos_filtra_produto_e_outlier_e_pega_o_mais_recente(tmp_path):
    p = _csv_precos(tmp_path, [
        "S;SC;FLORIANOPOLIS;P1;11.222.333/0001-44;RUA A;1;;CENTRO;88000-000;GASOLINA;01/10/2026;6,50;;R$/l;VIBRA",
        "S;SC;FLORIANOPOLIS;P1;11.222.333/0001-44;RUA A;1;;CENTRO;88000-000;GASOLINA;20/10/2026;6,70;;R$/l;VIBRA",
        "S;SC;FLORIANOPOLIS;P1;11.222.333/0001-44;RUA A;1;;CENTRO;88000-000;GASOLINA;25/10/2026;66,0;;R$/l;VIBRA",   # outlier
        "S;SC;FLORIANOPOLIS;P1;11.222.333/0001-44;RUA A;1;;CENTRO;88000-000;DIESEL S10;22/10/2026;6,10;;R$/l;VIBRA",
        "S;SC;FLORIANOPOLIS;P1;11.222.333/0001-44;RUA A;1;;CENTRO;88000-000;QUEROSENE;22/10/2026;6,10;;R$/l;VIBRA",   # produto fora do escopo
        "S;SC;FLORIANOPOLIS;P2;55.666.777/0001-88;RUA B;2;;CENTRO;88000-000;GASOLINA;01/08/2026;5,00;;R$/l;ALE",       # velho demais
    ])
    todos = tratar.ler_precos([p])
    assert sorted(todos["produto"].unique()) == ["Diesel S-10", "Gasolina comum"]
    assert 66.0 not in todos["preco"].values
    rec = tratar.precos_recentes(todos, dias=30)
    g = rec[(rec.cnpj == "11222333000144") & (rec.produto == "Gasolina comum")]
    assert g["preco"].item() == 6.70                      # coleta mais recente válida
    assert "55666777000188" not in set(rec.cnpj)          # fora da janela de 30 dias


def test_precos_layout_inesperado_falha_com_mensagem(tmp_path):
    p = tmp_path / "x.csv"
    p.write_text("a;b;c\n1;2;3\n", encoding="utf-8")
    with pytest.raises(ValueError, match="layout da ANP mudou"):
        tratar.ler_precos([p])


def test_casar_municipio_com_acento_e_alias():
    m = geo.carregar_municipios()
    df = pd.DataFrame({"uf": ["SP", "RN", "SC", "SP", "SP"],
                       "municipio": ["SAO PAULO", "ASSU", "PICARRAS", "SAO LUIS DO PARAITINGA", "NAO EXISTE"]})
    r = geo.casar_municipio(df, m)
    assert r["codigo_ibge"].tolist()[:4] == ["3550308", "2400208", "4212809", "3550001"]
    assert pd.isna(r["codigo_ibge"].iloc[4]) and r["municipio_nome"].iloc[4] == "Nao Existe"


def test_todos_municipios_do_ibge_casam_consigo_mesmos():
    m = geo.carregar_municipios()
    df = pd.DataFrame({"uf": m["uf"], "municipio": m["nome"]})
    r = geo.casar_municipio(df, m)
    assert r["codigo_ibge"].notna().all()
    assert (r["codigo_ibge"].values == m["codigo_ibge"].values).all()


def test_top3_confere_com_forca_bruta():
    import random
    rng = random.Random(1)
    linhas = []
    for i in range(60):
        linhas.append({"cnpj": f"{i:014d}", "nome": f"P{i}", "bandeira": "X", "endereco": "R", "bairro": "B",
                       "municipio_nome": "M", "uf": "SC", "codigo_ibge": "4205407", "produto": "Etanol",
                       "preco": round(rng.uniform(3, 6), 2), "data": pd.Timestamp("2026-10-10")})
    df = pd.DataFrame(linhas)
    t = ranking.top3(df)["Etanol"]
    ordenado = sorted(df["preco"])
    assert [x["preco"] for x in t["baratos"]] == ordenado[:3]
    assert [x["preco"] for x in t["caros"]] == ordenado[::-1][:3]
    assert ranking.top3(df.iloc[:2])["Etanol"]["baratos"].__len__() == 2   # menos de 3 postos: devolve o que há


def test_construir_demo_fim_a_fim(tmp_path):
    cad, prc = demo.gerar(tmp_path / "d", n_municipios=60)
    out = tmp_path / "pub"
    r = construir(cad, [prc], out, demo=True)
    assert (out / "index.html").exists() and (out / "app.js").exists() and (out / "vendor" / "leaflet.js").exists()
    resumo = json.loads((out / "dados" / "resumo.json").read_text(encoding="utf-8"))
    assert resumo["demo"] is True and resumo["n_postos"] == r["n_postos"]
    # a soma dos postos por UF, por município e o total do cadastro precisam fechar
    assert sum(u["n"] for u in resumo["ufs"]) == resumo["n_postos"]
    total_mun = 0
    for u in resumo["ufs"]:
        d = json.loads((out / "dados" / "uf" / f"{u['uf']}.json").read_text(encoding="utf-8"))
        assert sum(m["n"] for m in d["municipios"]) == u["n"]
        assert all(len(m["postos"]) == m["n"] for m in d["municipios"])
        total_mun += sum(m["n"] for m in d["municipios"])
    assert total_mun == resumo["n_postos"]
    assert sum(m[5] for m in resumo["municipios"]) == resumo["n_postos"] - resumo["n_sem_coordenada"]
    # ranking nacional: 3 baratos <= 3 caros, em ordem
    for prod, r_ in resumo["ranking_br"].items():
        b = [x["preco"] for x in r_["baratos"]]
        c = [x["preco"] for x in r_["caros"]]
        assert b == sorted(b) and c == sorted(c, reverse=True) and b[0] <= c[0]


def test_construir_sem_precos_gera_mapa(tmp_path):
    cad, _ = demo.gerar(tmp_path / "d", n_municipios=20)
    r = construir(cad, [], tmp_path / "pub")
    assert r["n_postos"] > 0 and r["produtos"] == [] and r["periodo_precos"] is None
