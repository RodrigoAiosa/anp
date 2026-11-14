"""Uso:  python -m anp_mapa {baixar|construir|tudo|demo} [opções]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .baixar import baixar_tudo
from .construir import construir
from .demo import gerar


def _resumo(r: dict) -> None:
    print(f"\nPostos no cadastro: {r['n_postos']:,}".replace(",", "."))
    print(f"Com preço recente:  {r['n_postos_com_preco']:,}".replace(",", "."))
    print(f"Sem coordenada (município não casado): {r['n_sem_coordenada']}")
    if r["periodo_precos"]:
        print(f"Preços de {r['periodo_precos'][0]} a {r['periodo_precos'][1]}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="anp_mapa", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("baixar", help="baixa cadastro e preços da ANP")
    b.add_argument("--pasta", type=Path, default=Path("dados_anp"))
    b.add_argument("--semestres", type=int, default=2)

    def opcoes_build(p):
        p.add_argument("--saida", type=Path, default=Path("public"))
        p.add_argument("--dias", type=int, default=30, help="janela de preços recentes (padrão 30)")
        p.add_argument("--uf", help="recorte, ex.: SC,PR (padrão: Brasil inteiro)")

    c = sub.add_parser("construir", help="gera o site a partir de arquivos já baixados")
    c.add_argument("--cadastro", type=Path, required=True)
    c.add_argument("--precos", type=Path, nargs="*", default=[])
    opcoes_build(c)

    t = sub.add_parser("tudo", help="baixa e constrói")
    t.add_argument("--pasta", type=Path, default=Path("dados_anp"))
    t.add_argument("--semestres", type=int, default=2)
    opcoes_build(t)

    d = sub.add_parser("demo", help="gera o site com dados FICTÍCIOS, sem internet")
    d.add_argument("--pasta", type=Path, default=Path("dados_demo"))
    opcoes_build(d)

    a = ap.parse_args(argv)
    ufs = [u.strip().upper() for u in a.uf.split(",")] if getattr(a, "uf", None) else None

    if a.cmd == "baixar":
        baixar_tudo(a.pasta, a.semestres)
    elif a.cmd == "construir":
        _resumo(construir(a.cadastro, a.precos, a.saida, a.dias, ufs=ufs))
    elif a.cmd == "tudo":
        cad, prc = baixar_tudo(a.pasta, a.semestres)
        _resumo(construir(cad, prc, a.saida, a.dias, ufs=ufs))
    elif a.cmd == "demo":
        cad, prc = gerar(a.pasta)
        _resumo(construir(cad, [prc], a.saida, a.dias, demo=True, ufs=ufs))
    print(f"\nSite em {a.saida}/  (abra com: python -m http.server -d {a.saida})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
