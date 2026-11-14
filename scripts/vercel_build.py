"""BUILD PARA A VERCEL: baixa os dados da ANP e monta public/.

    python3 scripts/vercel_build.py [--uf SC,PR] [--cadastro arq.csv --precos a.csv b.csv]

A Vercel roda isto a cada deploy (vercel.json -> buildCommand). Passos:
 1. garante pandas e requests (instala com pip --user se faltarem);
 2. baixa o cadastro e os preços da ANP (ou usa --cadastro/--precos);
 3. gera public/ (index, dados/, SEO, PWA, status.json). Se a conferência
    (soma dos postos por UF = cadastro) falhar, o build FALHA e a Vercel mantém
    o deploy anterior no ar.

Variáveis opcionais: UFS (recorte, ex.: SC,PR), DIAS (janela de preços, padrão 30),
SEMESTRES (quantos semestres de preços baixar, padrão 2), SITE_URL.
"""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def garantir_dependencias():
    faltam = [m for m in ("pandas", "requests") if importlib.util.find_spec(m) is None]
    if faltam:
        print("Instalando:", ", ".join(faltam), flush=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--user",
                        "--break-system-packages", "-r", str(RAIZ / "requirements.txt")], check=True)
        import site
        sys.path.insert(0, site.getusersitepackages())


def main(argv=None):
    garantir_dependencias()
    sys.path.insert(0, str(RAIZ))
    from anp_mapa.__main__ import main as cli

    args = list(sys.argv[1:] if argv is None else argv)
    if "--cadastro" in args:
        return cli(["construir", "--saida", str(RAIZ / "public")] + args)
    base = ["tudo", "--saida", str(RAIZ / "public"), "--pasta", str(RAIZ / "dados_anp"),
            "--dias", os.environ.get("DIAS", "30"), "--semestres", os.environ.get("SEMESTRES", "2")]
    if "--uf" not in args and os.environ.get("UFS"):
        base += ["--uf", os.environ["UFS"]]
    return cli(base + args)


if __name__ == "__main__":
    sys.exit(main())
