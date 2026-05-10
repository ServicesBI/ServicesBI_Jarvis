# PROTOCOLO OBRIGATÓRIO — JARVIS

Estas regras valem para Claude, Codex e qualquer agente dev.

## Arquivos principais

| Responsabilidade | Arquivo |
|-----------------|---------|
| HTML/UI principal | `public/index.html` |
| Backend, rotas, comandos, voz, mídia, arquivos, integrações | `server.js` |
| Frontend JS | `public/script.js` |
| CSS externo | `public/style.css` |
| CSS inline | `public/index.html` |

## Regras operacionais

1. Trabalhar somente nos arquivos principais reais.
2. Antes de alterar código, confirmar qual é o arquivo principal correspondente.
3. Fazer alterações cirúrgicas — não alterar fora do escopo solicitado.
4. Nunca criar backup, patch, rescue, fix, copy ou arquivo temporário.
5. Nunca editar `public/_quarentena_backups`.
6. Nunca restaurar `jarvis-rescue-bindings.js`.
7. Nunca criar `CODEX.md`.
8. Não declarar teste real de navegador se só testou headless ou não testou.
9. Não afirmar que executou ação se a ação não foi realmente executada.
10. Não afirmar que criou, editou ou salvou arquivos sem ter feito isso.

## Roteamento de voz, agentes e executores

1. A voz do Jarvis pode receber comandos e solicitações do usuário.
2. A voz pode abrir recursos quando o comando for explícito: YouTube, Spotify, Instagram, Excel, Power BI, arquivos, ERP, SaaS e outros sistemas autorizados.
3. A voz pode iniciar uma solicitação de análise, geração ou correção, mas não deve fazer alteração invisível.
4. Quando o pedido envolver análise técnica, erro, código, arquivo, planilha, PDF, ERP, SaaS ou automação, o Jarvis deve rotear a tarefa para o executor adequado.
5. O executor pode ser Claude, Codex ou outro agente definido no projeto.
6. Se a tarefa exigir alteração de código, o agente deve abrir no VSCode o arquivo principal real correspondente e editar diretamente esse arquivo.
7. HTML principal: `public/index.html`.
8. Backend, rotas, comandos, voz, mídia, arquivos, integrações, ERP e SaaS: `server.js`.
9. Frontend JS: `public/script.js`.
10. CSS externo: `public/style.css`.
11. CSS inline: `public/index.html`.
12. Nunca criar backup, patch, rescue, fix, copy ou arquivo paralelo.
13. Nunca editar arquivos dentro de `public/_quarentena_backups`.
14. Nunca afirmar que uma ação foi executada sem execução real.
15. Para escrita de arquivos, criação de planilhas, geração de PDFs ou alteração de código, manter confirmação de segurança quando aplicável.
16. Pesquisas externas poderão usar ChatGPT, Google, Perplexity ou outra fonte definida posteriormente.
17. O Jarvis deve responder ao usuário com o resultado da tarefa ou com o próximo passo necessário.

## Resposta final obrigatória

Toda entrega deve terminar com:

1. Arquivo alterado.
2. Causa.
3. Correção feita.
4. Validação executada.
5. Resultado.
