# Mapa de Postos de Combustíveis do Brasil (dados ANP)

Todos os postos revendedores **cadastrados na ANP**, por **estado**, **município** e **combustível**, com os
**3 mais baratos** e os **3 mais caros** em cada escopo (Brasil, estado, município). Python gera um site
estático (Leaflet) pronto para a **Vercel**, com o mesmo visual do
[MapaAntenasAnatel](https://github.com/RodrigoAiosa/MapaAntenasAnatel): tema escuro/claro, painel em seções,
ficha, mapa base alternável, PWA, SEO e cabeçalhos de segurança.

## O que ele mostra

| Recurso | Como funciona |
|---|---|
| Todos os postos | Cadastro de revendedores varejistas da ANP (CNPJ, razão social, bandeira, endereço) |
| Por estado e município | Seletores, busca e círculos no mapa (tamanho = nº de postos) |
| Cor dos círculos | **Preço médio** do combustível escolhido (verde barato → vermelho caro) ou **nº de postos** |
| Top 3 mais baratos / mais caros | Por combustível, no Brasil, no estado ou no município; clique para abrir o posto |
| Ficha | Município (totais, média, mínimo, máximo) ou posto (bandeira, CNPJ, preços coletados) |
| Resumo | Postos por bandeira no recorte |
| **Postos mais próximos** | Digite um **CEP** (consulta o ViaCEP) ou clique em **Usar minha localização** (GPS + OpenStreetMap/Nominatim para achar CEP e cidade). Lista os postos do município ordenados pela **proximidade de CEP** e, depois, os dos municípios vizinhos (até 35 km) |

> **"Mais próximo"** usa a distância em linha reta do pino (GPS, CEP ou clique no mapa; arrastável) até a coordenada de cada posto, num raio de 1 a 30 km. Posto sem coordenada na ANP fica no centro do município e é marcado como aproximado. O GPS só é lido depois do clique e da permissão.

Combustíveis: gasolina comum e aditivada, etanol, diesel S-500 e S-10 e GNV (arquivo de combustíveis automotivos da ANP;
GLP vem em outro arquivo e ainda não está incluído).

**Cobertura dos preços:** no primeiro build real (preços de jun/2026), 5.651 dos 45.840 postos tinham preço e só
413 dos 5.525 municípios tinham média, porque o levantamento da ANP cobre poucas centenas de municípios. Nos demais, o
mapa mostra o município em cinza e o Top 3 do estado/Brasil continua valendo.

## Dois conjuntos de dados, dois significados (leia isto)

1. **Cadastro de postos**: lista os postos autorizados. É daqui que vem "todos os postos".
2. **Levantamento de Preços de Combustíveis (LPC)**: a ANP coleta preços numa **amostra** de postos, toda semana.
   É daqui que vêm os rankings. O "mais barato" é o mais barato **entre os postos pesquisados** na janela de
   30 dias (`DIAS`) anterior à última coleta. Vale a coleta mais recente de cada posto/produto; preços fora de uma
   faixa plausível (ex.: gasolina < R$ 2 ou > R$ 20) são descartados.

**Posição no mapa:** esses arquivos não trazem latitude/longitude do posto. Cada posto fica no **centroide do
município** (IBGE) e é listado no painel. Municípios cuja grafia não casa com a do IBGE ficam sem círculo (seguem
na lista e nos rankings) e são relatados em `/dados/nao_casados.csv`; corrija com uma linha em `ALIAS`
(`anp_mapa/geo.py`).

## Publicar na Vercel

1. Na Vercel: **Add New → Project → Import** `RodrigoAiosa/anp`.
2. Não mude nada: o `vercel.json` já define o build (`python3 scripts/vercel_build.py`), a saída (`public/`) e os cabeçalhos.
   O script instala `pandas` e `requests` sozinho.
3. **Deploy.** O build baixa os dados da ANP, gera o site e **só publica se a conferência fechar**
   (soma dos postos por estado = cadastro); se falhar, o site anterior continua no ar.
4. *(Atualização semanal)* Em **Settings → Git → Deploy Hooks**, crie um hook para `main` e chame-o toda semana
   (cron externo ou GitHub Actions), ou use o plano B abaixo.

Variáveis opcionais (Settings → Environment Variables): `UFS` (recorte, ex.: `SC,PR`), `DIAS` (janela de preços,
padrão 30), `SEMESTRES` (semestres de preços baixados, padrão 2), `SITE_URL` (canonical/Open Graph).

> **Atenção:** o portal gov.br às vezes recusa downloads de provedores de nuvem. Isso **não foi testado a partir da
> Vercel**. Se o build falhar no download, use o **plano B**: o workflow `atualizar-vercel.yml` gera o site no
> GitHub e envia pronto com `vercel deploy --prebuilt` (secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
> `VERCEL_PROJECT_ID`). Ou baixe os CSVs à mão e rode `python3 scripts/vercel_build.py --cadastro … --precos …`.

## Desenvolvimento

```bash
pip install -r requirements-dev.txt

python -m anp_mapa demo        # site com dados FICTÍCIOS, sem internet (mostra um aviso na tela)
python -m anp_mapa tudo        # baixa da ANP e gera public/
python -m anp_mapa tudo --uf SC,PR
python -m anp_mapa construir --cadastro dados_anp/cadastro.csv --precos dados_anp/precos-2026-02.csv

python -m http.server 3000 -d public    # http://localhost:3000
python -m pytest -q                     # testes (offline)
```

`public/` é gerado: não edite. Edite `app/`, `anp_mapa/` ou `public_extra/`.

## Estrutura

```
anp_mapa/        baixar · tratar · geo · ranking · construir · demo · __main__
app/             index.html · app.js · style.css · fonts.css · vendor/ (Leaflet, Inter, Montserrat)
public_extra/    404, sobre (privacidade), manifest, sw.js, ícone, robots
scripts/         vercel_build.py
data/            municipios.csv (centroides do IBGE)
tests/           testes com dados inventados
.github/         ci.yml · atualizar-vercel.yml (plano B)
```

## Fontes e licenças

- Dados: ANP, dados abertos (cadastro de revendedores e série histórica de preços/LPC).
- Coordenadas dos municípios: IBGE, via [kelvins/municipios-brasileiros](https://github.com/kelvins/municipios-brasileiros).
- Visual e estrutura derivados do [MapaAntenasAnatel](https://github.com/RodrigoAiosa/MapaAntenasAnatel) (MIT, © João Victor Faraco).
- Mapa base © colaboradores do OpenStreetMap. Leaflet: BSD-2-Clause. Inter e Montserrat: SIL OFL (licenças em `app/vendor/`).
- Código: [MIT](LICENSE).


## Pontos por posto

O mapa desenha **cada posto como um ponto** (canvas, como o mapa de antenas). A posição vem da API de
Revendedores da ANP (`revendedoresapi.anp.gov.br/v1/combustivel`, campos Latitude/Longitude), baixada no build.
Coordenadas fora do Brasil, invertidas ou a mais de 150 km do município são descartadas. Posto sem coordenada
válida aparece no centro do município, com contorno branco. Se a API estiver fora do ar, o build continua e todos
os postos ficam no centro do município. Para pular a API: `SEM_API_COORDENADAS=1`.
