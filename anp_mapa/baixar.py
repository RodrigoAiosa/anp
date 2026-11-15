"""Download dos arquivos abertos da ANP.

Atenção: o portal gov.br pode recusar downloads de alguns provedores de nuvem.
Se isso acontecer, baixe os arquivos manualmente e use `--cadastro` e `--precos`.
"""
from __future__ import annotations

import datetime as dt
import re
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

# Desde 2023 a ANP publica um arquivo por MÊS e por grupo de produtos (não mais por semestre):
#   .../shpc/dsan/AAAA/precos-gasolina-etanol-MM.csv, precos-diesel-gnv-MM.csv e precos-glp-MM.csv
URL_MENSAL = BASE + "/shpc/dsan/{ano}/precos-{grupo}-{mes:02d}.csv"
GRUPOS_MENSAIS = ("gasolina-etanol", "diesel-gnv", "glp")
PAGINA_SERIE = "https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/serie-historica-de-precos-de-combustiveis"
_RE_MENSAL = re.compile(r"/shpc/dsan/(\d{4})/([^/?#\"']+)$", re.I)

# Preços SEMANAIS (um .xlsx por semana, domingo a sábado, publicado na sexta). Cobrem as semanas depois do último mês publicado.
PAGINA_LPC = "https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos"
PAGINAS_SEMANAIS = (PAGINA_LPC + "/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas",)
URL_SEMANAL = PAGINA_LPC + "/arquivos-lpc/{ano}/revendas_lpc_{ini}-{fim}.xlsx"   # nome real: revendas_lpc_2026_11_08-2026_11_14.xlsx
_RE_SEMANAL = re.compile(r"revendas[_-]lpc[_-](\d{4})[-._](\d{2})[-._](\d{2})[_-](\d{4})[-._](\d{2})[-._](\d{2})\.xlsx", re.I)

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


def meses_recentes(hoje: dt.date | None = None, quantos: int = 4) -> list[tuple[int, int]]:
    """(ano, mês) do corrente para trás."""
    hoje = hoje or dt.date.today()
    ano, mes = hoje.year, hoje.month
    saida = []
    for _ in range(quantos):
        saida.append((ano, mes))
        mes -= 1
        if mes == 0:
            ano, mes = ano - 1, 12
    return saida


def descobrir_mensais(html: str) -> dict[tuple[int, int], dict[str, str]]:
    """Lê da página da ANP os links dos arquivos mensais: {(ano, mês): {grupo: url}}."""
    achados: dict[tuple[int, int], dict[str, str]] = {}
    for href in sorted(set(re.findall(r'href="([^"]+)"', html))):
        m = _RE_MENSAL.search(href)
        if not m:
            continue
        ano, nome = int(m.group(1)), m.group(2).lower()
        grupo = next((g for g in GRUPOS_MENSAIS if g in nome), None)   # os nomes mudam de mês a mês
        mm = re.match(r"(?:precos-)?(\d{2})-", nome) or re.search(r"-(\d{2})(?:\.csv)?$", nome)
        if not grupo or not mm or not 1 <= int(mm.group(1)) <= 12:
            continue
        url = href if href.startswith("http") else "https://www.gov.br" + href if href.startswith("/") else href
        achados.setdefault((ano, int(mm.group(1))), {})[grupo] = url
    return achados


def baixar_precos_mensais(pasta: Path, meses: int = 3, hoje: dt.date | None = None) -> list[Path]:
    """Baixa os `meses` mais recentes publicados (todos os grupos de produtos de cada mês).
    Usa os links da página da ANP; se a página não responder, tenta o padrão de nome conhecido."""
    links: dict[tuple[int, int], dict[str, str]] = {}
    try:
        r = requests.get(PAGINA_SERIE, headers=CABECALHO, timeout=60)
        r.raise_for_status()
        links = descobrir_mensais(r.text)
    except requests.RequestException as e:
        print(f"  (página da ANP indisponível: {e}; uso o padrão de nome dos arquivos)", file=sys.stderr)
    if links:
        alvo = sorted(links, reverse=True)[:meses]
    else:
        alvo = meses_recentes(hoje, meses + 2)   # o mês corrente ainda pode não existir: sobra margem
        links = {ym: {g: URL_MENSAL.format(ano=ym[0], mes=ym[1], grupo=g) for g in GRUPOS_MENSAIS} for ym in alvo}
    achados: list[Path] = []
    meses_ok = 0
    for ym in alvo:
        if meses_ok >= meses:
            break
        ok_mes = False
        for grupo, url in sorted(links[ym].items()):
            destino = pasta / f"precos-{ym[0]}-{ym[1]:02d}-{grupo}.csv"
            if baixar(url, destino):
                achados.append(destino)
                ok_mes = True
        meses_ok += ok_mes
    return achados


def baixar_precos(pasta: Path, quantos: int = 2, hoje: dt.date | None = None, meses: int = 3) -> list[Path]:
    """Preços LPC: arquivos mensais (2023+). Se não houver nenhum, recua para os `quantos` semestres antigos que existirem (o semestre corrente costuma
    ainda não estar publicado: nesse caso recua)."""
    import os
    achados: list[Path] = baixar_precos_mensais(pasta, int(os.environ.get("MESES", meses)), hoje)
    if achados:
        return achados
    print("  Nenhum arquivo mensal encontrado: tentando os semestrais (até 2022).", file=sys.stderr)
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
    import os
    if os.environ.get("SEMANAIS", "1") != "0":
        print("Preços semanais (semanas depois do último mês publicado):")
        try:
            precos += baixar_semanais(pasta, fim_do_ultimo_mes(precos), maximo=int(os.environ.get("SEMANAS", "8")))
        except Exception as e:  # noqa: BLE001 - os semanais são um complemento
            print(f"  Sem preços semanais: {e}", file=sys.stderr)
    if not precos:
        print("  Nenhum arquivo de preços baixado: o mapa sairá sem o ranking.", file=sys.stderr)
    return cadastro, precos


# ----------------------------------------------------------------------------- semanais
def descobrir_semanais(html: str) -> dict[dt.date, str]:
    """Links dos arquivos semanais numa página da ANP: {último dia da semana: url do arquivo}."""
    achados: dict[dt.date, str] = {}
    for href in set(re.findall(r'href=["\']([^"\']+)["\']', html)):
        m = _RE_SEMANAL.search(href)
        if not m:
            continue
        try:
            fim = dt.date(int(m.group(4)), int(m.group(5)), int(m.group(6)))
        except ValueError:
            continue
        href = href[:m.end()]                                          # corta /view, /@@download/file...: fica o arquivo
        achados[fim] = href if href.startswith("http") else "https://www.gov.br" + href if href.startswith("/") else href
    return achados


def candidatos_semanais(hoje: dt.date | None = None, semanas: int = 10) -> dict[dt.date, list[str]]:
    """Plano B, sem ler a página: monta os nomes das últimas semanas (domingo a sábado)."""
    hoje = hoje or dt.date.today()
    fim = hoje - dt.timedelta(days=(hoje.weekday() + 2) % 7)        # sábado mais recente (<= hoje)
    saida: dict[dt.date, list[str]] = {}
    for k in range(semanas):
        f = fim - dt.timedelta(days=7 * k)
        i = f - dt.timedelta(days=6)
        saida[f] = [URL_SEMANAL.format(ano=a, ini=i.strftime("%Y_%m_%d"), fim=f.strftime("%Y_%m_%d")) for a in sorted({i.year, f.year})]
    return saida


def _eh_xlsx(caminho: Path) -> bool:
    try:
        with open(caminho, "rb") as f:
            return f.read(4) == b"PK\x03\x04"
    except OSError:
        return False


def fim_do_ultimo_mes(arquivos: list[Path]) -> dt.date | None:
    """Último dia do mês mais recente entre os arquivos mensais baixados (precos-AAAA-MM-grupo.csv)."""
    meses = []
    for a in arquivos:
        m = re.match(r"precos-(\d{4})-(\d{2})-", a.name)
        if m:
            meses.append((int(m.group(1)), int(m.group(2))))
    if not meses:
        return None
    ano, mes = max(meses)
    return (dt.date(ano + (mes == 12), mes % 12 + 1, 1) - dt.timedelta(days=1))


def baixar_semanais(pasta: Path, depois_de: dt.date | None, hoje: dt.date | None = None, maximo: int = 8) -> list[Path]:
    """Baixa os .xlsx semanais cuja semana termina depois de `depois_de` (os mais recentes primeiro).
    Nunca falha o build: sem os semanais, o mapa fica com os preços mensais."""
    hoje = hoje or dt.date.today()
    urls: dict[dt.date, list[str]] = {}
    paginas = list(PAGINAS_SEMANAIS) + [PAGINA_LPC + f"/arquivos-lpc/{a}" for a in sorted({hoje.year, (hoje - dt.timedelta(days=45)).year}, reverse=True)]
    for pag in paginas:
        try:
            r = requests.get(pag, headers=CABECALHO, timeout=30)
            r.raise_for_status()
            achou = descobrir_semanais(r.text)
            lpc = re.findall(r'href=["\']([^"\']*lpc[^"\']*)["\']', r.text, re.I)
            print(f"  página {pag.rsplit('/', 1)[-1]}: HTTP {r.status_code}, {len(r.text)} bytes, {len(achou)} semanal(is); "
                  f"links com 'lpc': {len(lpc)} {lpc[:2]}")
            for fim, u in achou.items():
                urls.setdefault(fim, [u])
        except requests.RequestException as e:
            print(f"  (página dos preços semanais indisponível: {pag.rsplit('/', 1)[-1]}: {e})", file=sys.stderr)
    for fim, lst in candidatos_semanais(hoje).items():          # completa com o padrão de nome
        urls.setdefault(fim, lst)
    alvo = sorted((f for f in urls if depois_de is None or f > depois_de), reverse=True)[:maximo]
    achados: list[Path] = []
    for fim in alvo:
        destino = pasta / f"semanal-{fim.isoformat()}.xlsx"
        for url in dict.fromkeys(urls[fim] + [urls[fim][0] + "/@@download/file"]):
            try:
                if baixar(url, destino, tentativas=2):
                    if _eh_xlsx(destino):
                        achados.append(destino)
                        break
                    print(f"  (não é um .xlsx: {url})", file=sys.stderr)
                    destino.unlink(missing_ok=True)
            except RuntimeError as e:
                print(f"  ({e})", file=sys.stderr)
    print(f"  semanais: {len(achados)} arquivo(s) depois de {depois_de or 'sempre'}")
    return achados
