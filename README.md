# Mapa de Postos de Combustíveis do Brasil (dados ANP)

Todos os postos revendedores **cadastrados na ANP**, navegáveis por **estado**, **município** e
**combustível**, com os **3 mais baratos** e os **3 mais caros** em cada escopo (Brasil, estado, município).
Projeto em Python que gera um site estático (Leaflet), no mesmo espírito do
[MapaAntenasAnatel](https://github.com/RodrigoAiosa/MapaAntenasAnatel).

## O que ele mostra

| Recurso | Como funciona |
|---|---|
| Todos os postos do Brasil | Cadastro de revendedores varejistas da ANP (CNPJ, razão social, bandeira, endereço) |
| Por estado e município | Filtros + círculos no mapa (tamanho = nº de postos); clique num município para abrir |
| Top 3 mais baratos / mais caros | Para cada combustível, no Brasil, no estado ou no município escolhido |
| Lista e busca | Postos do escopo, com filtro por nome, bandeira, bairro ou CNPJ, e os preços coletados |

Combustíveis: gasolina comum, gasolina aditivada, etanol, diesel S-500, diesel S-10, GNV e GLP (13 kg).

## Dois conjuntos de dados, dois significados (leia isto)

1. **Cadastro de postos** (`dados-cadastrais-revendedores-varejistas-combustiveis-automoveis.csv`): lista os postos
   autorizados. É daqui que vem "todos os postos".
2. **Levantamento de Preços de Combustíveis (LPC)**: a ANP coleta preços numa **amostra** de postos, toda semana.
   É daqui que vêm os rankings. Logo, o "mais barato" é o mais barato **entre os postos pesquisados** na janela
   de 30 dias (`--dias`) anterior à última coleta, não entre todos os postos do país. O preço usado é a coleta
   mais recente de cada posto/produto. Preços fora de uma faixa plausível (ex.: gasolina < R$ 2 ou > R$ 20) são descartados.

**Posição no mapa:** esses arquivos não trazem latitude/longitude do posto. Cada posto é posicionado no
**centroide do município** (IBGE) e listado no painel. Municípios cuja grafia não casa com a do IBGE ficam
sem ponto no mapa (continuam na lista e nos rankings) e são relatados em `public/dados/nao_casados.csv`;
corrija com uma linha em `ALIAS` (`anp_mapa/geo.py`).

## Uso

```bash
pip install -r requirements.txt

python -m anp_mapa demo                     # site com dados FICTÍCIOS, sem internet
python -m anp_mapa tudo                     # baixa da ANP e gera public/
python -m anp_mapa tudo --uf SC,PR          # só alguns estados (rápido)
python -m anp_mapa baixar                   # só baixa para dados_anp/
python -m anp_mapa construir --cadastro dados_anp/cadastro.csv \
       --precos dados_anp/precos-2026-02.csv --dias 30

python -m http.server -d public             # abrir http://localhost:8000
python -m pytest -q                         # testes (offline)
```

Se o download automático for recusado (o portal gov.br às vezes bloqueia IPs de nuvem), baixe os CSVs
manualmente no [portal de dados abertos da ANP](https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos)
e use `construir`.

## Publicar no GitHub Pages

1. Em **Settings → Pages**, escolha **Source: GitHub Actions**.
2. Rode o workflow **Atualizar e publicar** (aba Actions → *Run workflow*). Depois disso ele roda sozinho
   toda segunda-feira, às 06:00 de Brasília.

## Estrutura

```
anp_mapa/      baixar.py · tratar.py · geo.py · ranking.py · construir.py · demo.py · __main__.py
app/           index.html · app.js · style.css · vendor/ (Leaflet, BSD-2)
data/          municipios.csv (centroides do IBGE; fonte: kelvins/municipios-brasileiros)
tests/         testes com dados inventados
.github/       ci.yml (testes) · publicar.yml (atualização semanal + Pages)
```
`public/` é gerado: não edite.

## Fontes e licenças

- Dados: ANP, dados abertos (cadastro de revendedores e série histórica de preços/LPC).
- Coordenadas dos municípios: IBGE, via [kelvins/municipios-brasileiros](https://github.com/kelvins/municipios-brasileiros).
- Mapa base © colaboradores do OpenStreetMap. Leaflet: BSD-2-Clause (`app/vendor/LEAFLET-LICENSE.txt`).
- Código: [MIT](LICENSE).
