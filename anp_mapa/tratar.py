"""Leitura e limpeza dos CSVs da ANP (cadastro de postos e preços LPC)."""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from .util import chave_texto, cnpj_chave, para_float, sem_acento

COLUNAS_CADASTRO_POSICAO = [  # layout publicado pela ANP, usado se o arquivo vier sem cabeçalho
    "codigo", "autorizacao", "data_publicacao", "razao", "cnpj", "endereco",
    "complemento", "bairro", "cep", "uf", "municipio", "bandeira", "data_vinculacao",
]

# nome do produto na ANP -> rótulo exibido. A ordem define a ordem na tela.
PRODUTOS = {
    "GASOLINA": "Gasolina comum",
    "GASOLINA ADITIVADA": "Gasolina aditivada",
    "ETANOL": "Etanol",
    "DIESEL": "Diesel S-500",
    "DIESEL S10": "Diesel S-10",
    "GNV": "GNV",
    "GLP": "GLP (13 kg)",
}
# faixa plausível de preço por produto (descarta erros de digitação da coleta)
FAIXA_PRECO = {
    "Gasolina comum": (2, 20), "Gasolina aditivada": (2, 20), "Etanol": (1.5, 15),
    "Diesel S-500": (2, 20), "Diesel S-10": (2, 20), "GNV": (1.5, 15), "GLP (13 kg)": (40, 300),
}


# colunas dos preços que não usamos: não são lidas, para poupar memória (o CSV tem ~80 MB)
_DESCARTAR_PRECOS = {"REGIAO SIGLA", "VALOR DE COMPRA", "UNIDADE DE MEDIDA", "COMPLEMENTO"}


def _ler_csv(caminho: Path, **kw) -> pd.DataFrame:
    erro = None
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(caminho, sep=";", dtype=str, encoding=enc,
                               on_bad_lines="skip", keep_default_na=False, **kw)
        except UnicodeDecodeError as e:
            erro = e
    raise erro  # type: ignore[misc]


def _celula_texto(v) -> str:
    if v is None or (isinstance(v, float) and v != v):
        return ""
    if isinstance(v, float) and v.is_integer():          # CEP/CNPJ lidos como número
        return str(int(v))
    return str(v).strip()


def _ler_xlsx(caminho: Path) -> pd.DataFrame:
    """Planilha semanal da ANP (revendas_lpc_*.xlsx): acha a linha do cabeçalho e devolve tudo
    como texto, menos VALOR e DATA (que ficam como a planilha trouxe: número/data ou texto)."""
    bruto = pd.read_excel(caminho, header=None, dtype=object, engine="openpyxl")
    topo = None
    for i in range(min(len(bruto), 60)):
        cel = [chave_texto(x) for x in bruto.iloc[i].tolist() if isinstance(x, str)]
        if any("CNPJ" in c for c in cel) and any(c == "PRODUTO" for c in cel):
            topo = i
            break
    if topo is None:
        raise ValueError(f"{caminho.name}: não achei o cabeçalho (CNPJ/PRODUTO): layout da ANP mudou?")
    df = bruto.iloc[topo + 1:].copy()
    df.columns = [str(c) for c in bruto.iloc[topo].tolist()]
    df = df.loc[:, [c for c in df.columns if c != "nan" and chave_texto(c) not in _DESCARTAR_PRECOS]]
    df = df.loc[:, ~df.columns.duplicated()]
    for c in df.columns:
        n = chave_texto(c)
        if n.startswith("VALOR") or n.startswith("DATA"):
            continue
        df[c] = df[c].map(_celula_texto)
    return df.dropna(how="all").reset_index(drop=True)


def _renomear(df: pd.DataFrame, regras: dict[str, tuple[str, ...]]) -> pd.DataFrame:
    """Renomeia colunas por palavra-chave, ignorando acento/caixa."""
    novo, usados = {}, set()
    for col in df.columns:
        n = chave_texto(col)
        for destino, palavras in regras.items():
            if destino in usados:
                continue
            if any(n == p or (len(p) > 3 and p in n) for p in palavras):
                novo[col] = destino
                usados.add(destino)
                break
    return df.rename(columns=novo)


def ler_cadastro(caminho: Path) -> pd.DataFrame:
    """Todos os postos revendedores autorizados pela ANP."""
    df = _ler_csv(caminho)
    regras = {
        "codigo": ("CODIGO SIMP", "CODIGO"), "razao": ("RAZAO SOCIAL", "RAZAO"),
        "cnpj": ("CNPJ",), "endereco": ("ENDERECO",), "complemento": ("COMPLEMENTO",),
        "bairro": ("BAIRRO",), "cep": ("CEP",), "uf": ("UF", "ESTADO"),
        "municipio": ("MUNICIPIO",), "bandeira": ("BANDEIRA",),
    }
    df = _renomear(df, regras)
    if "cnpj" not in df.columns:  # arquivo sem cabeçalho
        df = _ler_csv(caminho, header=None)
        df = df.iloc[:, : len(COLUNAS_CADASTRO_POSICAO)]
        df.columns = COLUNAS_CADASTRO_POSICAO[: df.shape[1]]
    for c in ("razao", "endereco", "complemento", "bairro", "cep", "bandeira", "codigo"):
        if c not in df.columns:
            df[c] = ""
    faltam = {"cnpj", "uf", "municipio"} - set(df.columns)
    if faltam:
        raise ValueError(f"Cadastro sem as colunas {sorted(faltam)}: layout da ANP mudou?")
    out = pd.DataFrame({
        "cnpj": df["cnpj"].map(cnpj_chave),
        "razao": df["razao"].str.strip(),
        "bandeira": df["bandeira"].str.strip().replace("", "BANDEIRA BRANCA"),
        "endereco": df["endereco"].str.replace(r"\s+", " ", regex=True).str.strip(),
        "complemento": df["complemento"].str.strip(),
        "bairro": df["bairro"].str.strip(),
        "cep": df["cep"].str.replace(r"\D", "", regex=True).map(lambda c: c.zfill(8) if c else c),
        "uf": df["uf"].str.strip().str.upper(),
        "municipio": df["municipio"].str.strip(),
    })
    out = out[(out["cnpj"] != "") & (out["uf"].str.len() == 2)]
    # o mesmo CNPJ (estabelecimento) pode ter mais de uma autorização: fica a última linha
    return out.drop_duplicates("cnpj", keep="last").reset_index(drop=True)


def ler_precos(caminhos: list[Path]) -> pd.DataFrame:
    """Série de preços LPC, já com produto padronizado e preço numérico."""
    partes = []
    regras = {
        "uf": ("ESTADO SIGLA", "ESTADO"), "municipio": ("MUNICIPIO",),
        "revenda": ("REVENDA",), "cnpj": ("CNPJ DA REVENDA", "CNPJ"),
        "rua": ("NOME DA RUA",), "numero": ("NUMERO RUA",), "complemento": ("COMPLEMENTO",),
        "bairro": ("BAIRRO",), "cep": ("CEP",), "produto": ("PRODUTO",),
        "data": ("DATA DA COLETA", "DATA"), "preco": ("VALOR DE VENDA", "PRECO DE REVENDA", "PRECO REVENDA", "PRECO DE VENDA", "VALOR DE REVENDA"),
        "bandeira": ("BANDEIRA",),
    }
    for p in caminhos:
        if p.suffix.lower() == ".xlsx":
            try:
                bruto = _ler_xlsx(p)
            except Exception as e:  # noqa: BLE001 - semanal é complemento: não derruba o mapa
                print(f"  (ignorei {p.name}: {e})", file=sys.stderr)
                continue
        else:
            bruto = _ler_csv(p, usecols=lambda c: chave_texto(c) not in _DESCARTAR_PRECOS)
        df = _renomear(bruto, regras)
        faltam = {"uf", "municipio", "cnpj", "produto", "data", "preco"} - set(df.columns)
        if faltam and p.suffix.lower() == ".xlsx":      # semanal é complemento: avisa, mostra as colunas e segue
            print(f"  (ignorei {p.name}: faltam {sorted(faltam)}; colunas lidas: {list(bruto.columns)})", file=sys.stderr)
            continue
        if faltam:
            raise ValueError(f"{p.name}: faltam colunas {sorted(faltam)}: layout da ANP mudou?")
        for c in ("revenda", "rua", "numero", "bairro", "cep", "bandeira"):
            if c not in df.columns:
                df[c] = ""
        df["data"] = pd.to_datetime(df["data"], dayfirst=True, errors="coerce")
        partes.append(df)
    if not partes:
        raise ValueError("nenhum arquivo de preços legível")
    df = pd.concat(partes, ignore_index=True)

    prod = df["produto"].map(lambda x: PRODUTOS.get(chave_texto(x).replace("  ", " ")))
    out = pd.DataFrame({
        "cnpj": df["cnpj"].map(cnpj_chave),
        "nome": df["revenda"].str.strip(),
        "uf": df["uf"].str.strip().str.upper(),
        "municipio": df["municipio"].str.strip(),
        "endereco": (df["rua"].str.strip() + ", " + df["numero"].str.strip()).str.strip(", "),
        "bairro": df["bairro"].str.strip(),
        "cep": df["cep"].str.replace(r"\D", "", regex=True).map(lambda c: c.zfill(8) if c else c),
        "bandeira": df["bandeira"].str.strip(),
        "produto": prod,
        "data": pd.to_datetime(df["data"], dayfirst=True, errors="coerce"),
        "preco": df["preco"].map(para_float),
    })
    out = out.dropna(subset=["produto", "data", "preco"])
    ok = pd.Series(False, index=out.index)
    for produto, (lo, hi) in FAIXA_PRECO.items():
        ok |= (out["produto"] == produto) & out["preco"].between(lo, hi)
    out = out[ok & (out["cnpj"] != "")]
    return out.reset_index(drop=True)


def precos_recentes(precos: pd.DataFrame, dias: int = 30) -> pd.DataFrame:
    """Preço mais recente de cada (posto, produto), dentro de `dias` antes da última coleta."""
    if precos.empty:
        return precos
    corte = precos["data"].max() - pd.Timedelta(days=dias)
    p = precos[precos["data"] >= corte]
    p = p.sort_values(["data"]).drop_duplicates(["cnpj", "produto"], keep="last")
    return p.reset_index(drop=True)


def ordem_produtos(produtos) -> list[str]:
    ordem = list(PRODUTOS.values())
    return sorted(set(produtos), key=lambda x: ordem.index(x) if x in ordem else 99)


__all__ = ["ler_cadastro", "ler_precos", "precos_recentes", "ordem_produtos", "PRODUTOS", "sem_acento"]
