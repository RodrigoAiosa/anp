"""Dados FICTÍCIOS (mesmo layout dos CSVs da ANP) para testar o pipeline offline.

Municípios e UFs são reais; postos, CNPJs, razões sociais e preços são inventados.
"""
from __future__ import annotations

import csv
import random
from pathlib import Path

from .geo import carregar_municipios
from .util import sem_acento

BANDEIRAS = ["VIBRA ENERGIA", "IPIRANGA", "RAIZEN", "BANDEIRA BRANCA", "ALE", "TORRAO"]
BASE_PRECO = {"GASOLINA": 6.2, "GASOLINA ADITIVADA": 6.5, "ETANOL": 4.4, "DIESEL": 6.1,
              "DIESEL S10": 6.3, "GNV": 4.9, "GLP": 105.0}


def _cnpj(rng: random.Random) -> str:
    return "".join(str(rng.randint(0, 9)) for _ in range(14))


def gerar(pasta: Path, n_municipios: int = 400, semente: int = 7) -> tuple[Path, Path, Path]:
    rng = random.Random(semente)
    pasta.mkdir(parents=True, exist_ok=True)
    m = carregar_municipios().sample(n=n_municipios, random_state=semente)
    cad = pasta / "cadastro.csv"
    prc = pasta / "precos-demo.csv"
    coord = pasta / "coordenadas.csv"
    linhas_coord = []
    with open(cad, "w", newline="", encoding="utf-8") as fc, open(prc, "w", newline="", encoding="utf-8") as fp:
        wc, wp = csv.writer(fc, delimiter=";"), csv.writer(fp, delimiter=";")
        wc.writerow(["CODIGO SIMP", "AUTORIZACAO", "DATA PUBLICACAO", "RAZAO SOCIAL", "CNPJ", "ENDERECO",
                     "COMPLEMENTO", "BAIRRO", "CEP", "UF", "MUNICIPIO", "BANDEIRA", "DATA VINCULACAO"])
        wp.writerow(["Regiao - Sigla", "Estado - Sigla", "Municipio", "Revenda", "CNPJ da Revenda", "Nome da Rua",
                     "Numero Rua", "Complemento", "Bairro", "Cep", "Produto", "Data da Coleta",
                     "Valor de Venda", "Valor de Compra", "Unidade de Medida", "Bandeira"])
        k = 0
        for r in m.itertuples():
            fator_uf = 0.9 + (int(r.codigo_ibge[:2]) % 7) * 0.03
            for _ in range(rng.randint(1, 25)):
                k += 1
                cnpj, band = _cnpj(rng), rng.choice(BANDEIRAS)
                nome = f"POSTO DEMO {k:05d} LTDA"
                rua, num = f"RUA DEMO {rng.randint(1, 99)}", str(rng.randint(1, 2000))
                nm = sem_acento(r.nome).upper()
                if rng.random() < 0.9:   # ~10% sem coordenada, como acontece na base real
                    linhas_coord.append([cnpj, round(r.latitude + rng.uniform(-0.06, 0.06), 6),
                                         round(r.longitude + rng.uniform(-0.06, 0.06), 6), "anp", 10, "OK"])
                wc.writerow([k, f"PR/{r.uf}{k:07d}", "01/01/2020", nome, cnpj, f"{rua}, {num}", "", "CENTRO",
                             f"{rng.randint(10000000, 99999999)}", r.uf, nm, band, "01/01/2020"])
                if rng.random() < 0.35:  # só parte dos postos tem preço coletado (como no LPC real)
                    for prod, base in BASE_PRECO.items():
                        if prod in ("GNV", "GLP") and rng.random() < 0.6:
                            continue
                        preco = base * fator_uf * rng.uniform(0.92, 1.12)
                        wp.writerow(["X", r.uf, nm, nome, cnpj, rua, num, "", "CENTRO", "00000-000", prod,
                                     f"{rng.randint(1, 28):02d}/10/2026", f"{preco:.2f}".replace(".", ","),
                                     "", "R$/l", band])
    with open(coord, "w", newline="", encoding="utf-8") as fk:
        w = csv.writer(fk)
        w.writerow(["cnpj", "lat", "lon", "origem", "acuracia_m", "validacao"])
        w.writerows(linhas_coord)
    return cad, prc, coord
