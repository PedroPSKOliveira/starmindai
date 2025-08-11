# diRavena Assistant

Chatbot (React + Node/Vercel) que lê o site da diRavena e responde perguntas objetivas como:
- “Quanto custa um sapatênis?”
- “Qual mocatênis é o mais barato?”
- “Qual a camiseta mais cara?”

## Características
- **Sem banco de dados**: o backend raspa páginas públicas e monta um catálogo em memória.
- **Preço promocional primeiro**: prioriza sempre o valor com desconto (quando existir).
- **Perguntas naturais**: entende “quanto custa”, “mais barato” e “mais caro”.
- **Monorepo simples**: 1 arquivo de front (`index.html`) e 1 de back (`api/index.js`).

## Como funciona (resumo)
1. Coleta links das listagens (home, “mais vendidos”…).
2. Abre cada produto e extrai o **preço com desconto** via JSON de produto/JSON-LD/metatags.
3. Normaliza a pergunta e encontra os itens mais relevantes.
4. Responde de forma curta com base **apenas** no que foi coletado.


## Demonstração
![Demo](https://starmindai-c3rlkvt57-pedropskoliveiras-projects.vercel.app/)