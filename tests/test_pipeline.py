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
    cad, prc, coord = demo.gerar(tmp_path / "d", n_municipios=60)
    out = tmp_path / "pub"
    r = construir(cad, [prc], out, demo=True, coordenadas=coord)
    assert (out / "index.html").exists() and (out / "app.js").exists() and (out / "vendor" / "leaflet.js").exists()
    idx = (out / "index.html").read_text(encoding="utf-8")
    assert 'rel="manifest"' in idx and "serviceWorker" in idx
    assert "{{" not in (out / "sw.js").read_text(encoding="utf-8")
    assert "{{" not in (out / "sobre.html").read_text(encoding="utf-8")
    assert json.loads((out / "status.json").read_text(encoding="utf-8"))["postos"] == r["n_postos"]
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
    assert all(isinstance(m[6], dict) for m in resumo["municipios"])   # preço médio por município
    assert sum(m[5] for m in resumo["municipios"]) == resumo["n_postos"] - resumo["n_sem_coordenada"]
    # ranking nacional: 3 baratos <= 3 caros, em ordem
    for prod, r_ in resumo["ranking_br"].items():
        b = [x["preco"] for x in r_["baratos"]]
        c = [x["preco"] for x in r_["caros"]]
        assert b == sorted(b) and c == sorted(c, reverse=True) and b[0] <= c[0]


def test_construir_sem_precos_gera_mapa(tmp_path):
    cad, _, _ = demo.gerar(tmp_path / "d", n_municipios=20)
    r = construir(cad, [], tmp_path / "pub")
    assert r["n_postos"] > 0 and r["produtos"] == [] and r["periodo_precos"] is None


def test_extrair_csv_de_zip(tmp_path):
    import zipfile
    from anp_mapa.baixar import extrair_csv
    z = tmp_path / "ca.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("ca-2026-01.csv", "a;b\n1;2\n")
    out = extrair_csv(z, tmp_path / "ca.csv")
    assert out.read_text() == "a;b\n1;2\n" and not z.exists()


def test_baixar_precos_recua_para_semestre_publicado(tmp_path, monkeypatch):
    import datetime as dt
    from anp_mapa import baixar as b
    tentadas = []

    def falso(url, destino, tentativas=3):
        tentadas.append(url.rsplit("/", 1)[1])
        if "ca-2026-01.zip" in url:
            import zipfile
            with zipfile.ZipFile(destino, "w") as f:
                f.writestr("x.csv", "a;b\n")
            return True
        return False

    monkeypatch.setattr(b, "baixar", falso)
    monkeypatch.setattr(b, "baixar_precos_mensais", lambda *a, **k: [])   # sem arquivos mensais: cai nos semestrais
    r = b.baixar_precos(tmp_path, quantos=1, hoje=dt.date(2026, 11, 14))
    assert [p.name for p in r] == ["precos-2026-01.csv"]
    assert tentadas[:3] == ["ca-2026-02.zip", "ca-2026-02.csv", "ca-2026-01.zip"]


def test_precos_ignora_colunas_nao_usadas_e_le_bom(tmp_path):
    p = _csv_precos(tmp_path, ["S;SC;FLORIANOPOLIS;P1;11.222.333/0001-44;RUA A;1;;CENTRO;88000-000;ETANOL;10/06/2026;4,59;;R$/l;VIBRA"])
    df = tratar.ler_precos([p])
    assert len(df) == 1 and df["preco"].item() == 4.59 and df["produto"].item() == "Etanol"


def test_descobrir_mensais_le_links_da_pagina():
    from anp_mapa import baixar as b
    base = "/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/dsan/2026/"
    html = "".join(f'<a href="{base}precos-{g}-{m:02d}.csv">x</a>' for g in b.GRUPOS_MENSAIS for m in (9, 10)) \
        + f'<a href="{base}01-gasolina-etanol.csv">z</a><a href="/outro/ca-2022-01.csv">y</a>'
    r = b.descobrir_mensais(html)
    assert sorted(r) == [(2026, 1), (2026, 9), (2026, 10)]   # 2026-01 com outro padrão de nome
    assert set(r[(2026, 10)]) == {"gasolina-etanol", "diesel-gnv", "glp"}
    assert r[(2026, 10)]["glp"].startswith("https://www.gov.br/anp/")


def test_baixar_precos_mensais_usa_os_meses_mais_recentes(tmp_path, monkeypatch):
    import datetime as dt
    from anp_mapa import baixar as b
    tentadas = []

    def falso(url, destino, tentativas=3):
        tentadas.append(destino.name)
        return "2026-11" not in destino.name   # novembro ainda não publicado
    monkeypatch.setattr(b, "baixar", falso)

    class Resp:  # página fora do ar: usa o padrão de nome
        def raise_for_status(self): raise b.requests.RequestException("sem rede")
    monkeypatch.setattr(b.requests, "get", lambda *a, **k: Resp())
    r = b.baixar_precos_mensais(tmp_path, meses=2, hoje=dt.date(2026, 11, 14))
    nomes = sorted(p.name for p in r)
    assert nomes[0].startswith("precos-2026-09") and nomes[-1].startswith("precos-2026-10")
    assert len(nomes) == 6   # 2 meses x 3 grupos


def _xlsx_semanal(caminho, linhas, preambulo=3):
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active
    for i in range(preambulo):
        ws.append([f"Levantamento de preços (linha de título {i})"])
    ws.append(["REGIÃO - SIGLA", "ESTADO - SIGLA", "MUNICÍPIO", "REVENDA", "CNPJ DA REVENDA", "NOME DA RUA",
               "NÚMERO RUA", "COMPLEMENTO", "BAIRRO", "CEP", "PRODUTO", "DATA DA COLETA", "VALOR DE VENDA",
               "VALOR DE COMPRA", "UNIDADE DE MEDIDA", "BANDEIRA"])
    for l in linhas:
        ws.append(l)
    wb.save(caminho)


def test_le_planilha_semanal_xlsx_com_numeros_e_datas(tmp_path):
    import datetime as dt
    p = tmp_path / "semanal.xlsx"
    _xlsx_semanal(p, [
        ["SE", "SP", "SAO PAULO", "POSTO A", 1234567000199, "RUA X", "10", "", "CENTRO", 1310100.0, "GASOLINA",
         dt.datetime(2026, 11, 3), 6.29, 5.1, "R$/l", "VIBRA"],
        ["SE", "SP", "SAO PAULO", "POSTO A", "01.234.567/0001-99", "RUA X", "10", "", "CENTRO", "01310-100", "GLP",
         "04/11/2026", "R$ 112,50", "", "R$/13kg", "VIBRA"],
        ["SE", "SP", "SAO PAULO", "POSTO B", "98765432000110", "RUA Y", "5", "", "BELA VISTA", "01310100", "ETANOL",
         dt.datetime(2026, 11, 5), "4,79", "", "R$/l", "BRANCA"],
        ["SE", "SP", "SAO PAULO", "POSTO C", "11111111000111", "RUA Z", "1", "", "X", "01310100", "GASOLINA",
         dt.datetime(2026, 11, 5), 600.0, "", "R$/l", "BRANCA"],     # preço absurdo: filtrado
    ])
    df = tratar.ler_precos([p])
    assert len(df) == 3
    a = df[df.cnpj == "01234567000199"].set_index("produto")
    assert a.loc["Gasolina comum", "preco"] == 6.29 and a.loc["GLP (13 kg)", "preco"] == 112.5
    assert a.loc["Gasolina comum", "cep"] == "01310100" and a.loc["Gasolina comum", "data"] == pd.Timestamp("2026-11-03")
    assert a.loc["GLP (13 kg)", "data"] == pd.Timestamp("2026-11-04")


def test_semanal_soma_aos_mensais_e_vence_o_mais_novo(tmp_path):
    import datetime as dt
    mensal = tmp_path / "precos-2026-10-gasolina-etanol.csv"
    mensal.write_text("ESTADO - SIGLA;MUNICÍPIO;REVENDA;CNPJ DA REVENDA;PRODUTO;DATA DA COLETA;VALOR DE VENDA\n"
                      "SP;SAO PAULO;POSTO A;01234567000199;GASOLINA;28/10/2026;6,50\n", encoding="utf-8")
    sem = tmp_path / "semanal.xlsx"
    _xlsx_semanal(sem, [["SE", "SP", "SAO PAULO", "POSTO A", "01234567000199", "R", "1", "", "C", "1", "GASOLINA",
                         dt.datetime(2026, 11, 3), 6.19, "", "R$/l", "VIBRA"]])
    todos = tratar.ler_precos([mensal, sem])
    rec = tratar.precos_recentes(todos, 30)
    assert len(rec) == 1 and rec.iloc[0]["preco"] == 6.19 and rec.iloc[0]["data"] == pd.Timestamp("2026-11-03")


def test_xlsx_ilegivel_nao_derruba(tmp_path):
    ruim = tmp_path / "ruim.xlsx"; ruim.write_bytes(b"<html>nao e xlsx</html>")
    csv_ = tmp_path / "p.csv"
    csv_.write_text("ESTADO - SIGLA;MUNICÍPIO;REVENDA;CNPJ DA REVENDA;PRODUTO;DATA DA COLETA;VALOR DE VENDA\n"
                    "SP;SAO PAULO;POSTO A;01234567000199;GASOLINA;28/10/2026;6,50\n", encoding="utf-8")
    assert len(tratar.ler_precos([ruim, csv_])) == 1


def test_descobrir_e_candidatos_semanais():
    import datetime as dt
    from anp_mapa import baixar
    html = ('<a href="/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/revendas_lpc_2026-10-25_2026-10-31.xlsx/view">x</a>'
            '<a href="https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/arquivos-lpc/2026/revendas_lpc_2026-11-01_2026-11-07.xlsx">y</a>'
            '<a href="/x/resumo_semanal_lpc_2026-11-01_2026-11-07.xlsx/view">nao</a>')
    achados = baixar.descobrir_semanais(html)
    assert set(achados) == {dt.date(2026, 10, 31), dt.date(2026, 11, 7)}
    assert achados[dt.date(2026, 10, 31)].endswith("revendas_lpc_2026-10-25_2026-10-31.xlsx")
    assert achados[dt.date(2026, 10, 31)].startswith("https://www.gov.br/")
    c = baixar.candidatos_semanais(dt.date(2026, 11, 14), 3)       # sábado: a semana de 08 a 14/11 ainda vale
    assert list(c)[0] == dt.date(2026, 11, 14) and list(c)[1] == dt.date(2026, 11, 7)
    assert "revendas_lpc_2026-11-01_2026-11-07.xlsx" in c[dt.date(2026, 11, 7)][0]
    virada = baixar.candidatos_semanais(dt.date(2026, 1, 3), 1)[dt.date(2026, 1, 3)]
    assert len(virada) == 2 and "/2025/" in virada[0] and "/2026/" in virada[1]
    assert baixar.fim_do_ultimo_mes([Path("precos-2026-10-glp.csv"), Path("precos-2026-09-glp.csv")]) == dt.date(2026, 10, 31)
    assert baixar.fim_do_ultimo_mes([Path("precos-2026-12-glp.csv")]) == dt.date(2026, 12, 31)


def test_baixar_semanais_pega_so_as_depois_do_ultimo_mes(tmp_path, monkeypatch):
    import datetime as dt
    from anp_mapa import baixar

    def falso_get(url, **kw):
        raise baixar.requests.ConnectionError("sem rede")
    monkeypatch.setattr(baixar.requests, "get", falso_get)
    pedidos = []

    def falso_baixar(url, destino, tentativas=3):
        pedidos.append(url)
        if "2026-11-01_2026-11-07" in url and "/@@download/file" not in url:
            _xlsx_semanal(destino, [])
            return True
        return False
    monkeypatch.setattr(baixar, "baixar", falso_baixar)
    r = baixar.baixar_semanais(tmp_path, dt.date(2026, 10, 31), hoje=dt.date(2026, 11, 14))
    assert [x.name for x in r] == ["semanal-2026-11-07.xlsx"]
    assert not any("2026-10-18" in u for u in pedidos)       # semanas dentro do mês já publicado não são pedidas
