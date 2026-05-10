# PRD.md — Integração Codex + Claude no JARVIS v8.1

## 1. Objetivo

Este documento define o plano técnico para adicionar suporte ao Codex/OpenAI no projeto JARVIS v8.1, mantendo o Claude CLI como executor existente.

O objetivo não é substituir o Claude.

O objetivo é transformar o JARVIS em um assistente híbrido:

- Claude CLI: executor atual para tarefas complexas.
- Codex CLI/OpenAI Codex: executor alternativo e futuro fallback.
- OpenAI API: voz, STT, TTS, Realtime, GPT rápido, visão e embeddings.

A implementação deve ser feita por fases, com validação após cada etapa.

---

## 2. Contexto atual do projeto

O JARVIS é um assistente local para Windows.

Ele roda em:

    http://localhost:3000

O backend é Node.js com Express.

O projeto é iniciado por:

    node server.js

ou:

    npm start

O arquivo `package.json` define o projeto como ES Modules e possui scripts como:

    "jarvis": "node server.js"
    "start": "node server.js"

O sistema atual possui:

- Backend principal em `server.js`.
- Interface web em `public/index.html`.
- Lógica do frontend em `public/script.js`.
- Scripts Python em `system/`.
- Memória em `system/JARVIS-MEMORY.md`.
- Histórico em `system/JARVIS-HISTORY.json`.
- Embeddings em `system/memory-embeddings.json`.
- Entregáveis em `Documents and Projects/`.
- Integração com Obsidian.
- Integração com Claude CLI.
- Integração com OpenAI API.
- Voz, STT, TTS e Realtime.
- Computer Use.
- Controle de navegador.
- Leitura de tela.
- Geração de PDF.
- Leitura/edição de Excel.
- Desktop Pet.
- Launcher Electron.

---

## 3. Problema

Hoje o JARVIS depende muito do Claude CLI para executar tarefas complexas, criar arquivos, alterar código e operar automações.

Quando o Claude:

- atinge limite de uso;
- está deslogado;
- está offline;
- apresenta erro de autenticação;
- retorna saída vazia;
- sofre timeout;
- ou não está disponível;

o JARVIS perde capacidade operacional.

O usuário pretende usar ChatGPT Business + Codex e deseja preparar o JARVIS para também usar Codex/OpenAI como executor alternativo.

---

## 4. Objetivo final da alteração

Criar uma camada de execução híbrida:

    Usuário
      ↓
    HUD / Voz / Texto
      ↓
    server.js
      ↓
    Executor Router
      ├── Claude Provider
      ├── Codex Provider
      └── OpenAI Provider

O sistema deve suportar os modos:

- auto
- claude
- codex
- openai

### 4.1 Modo auto

Comportamento esperado:

1. Tentar Claude primeiro quando for tarefa complexa.
2. Se Claude falhar por limite, autenticação, indisponibilidade, timeout, saída vazia ou erro de processo, tentar Codex.
3. Se Codex também falhar, retornar erro amigável.
4. Nunca afirmar que criou arquivo ou alterou código se isso não aconteceu.

### 4.2 Modo claude

Usar somente Claude.

Se Claude falhar, retornar erro amigável.

### 4.3 Modo codex

Usar somente Codex.

Se Codex falhar, retornar erro amigável.

### 4.4 Modo openai

Usar somente OpenAI API para resposta textual, planejamento ou explicação.

Não fingir execução local de arquivos.

---

## 5. Premissa de segurança sem GitHub

O projeto ainda não foi enviado para GitHub.

Portanto, antes de qualquer implementação, deve existir uma cópia local da pasta original.

### 5.1 Backup obrigatório

Antes de alterar qualquer arquivo, criar uma cópia completa da pasta atual:

    C:\Users\Leles\python\Jarvis

Para:

    C:\Users\Leles\python\Jarvis_BACKUP_ANTES_CODEX

ou:

    C:\Users\Leles\python\Jarvis_ORIGINAL

A pasta backup não deve ser alterada.

### 5.2 Rollback manual

Se algo quebrar:

1. Fechar o servidor.
2. Fechar o VS Code.
3. Renomear a pasta com problema para `Jarvis_COM_PROBLEMA`.
4. Copiar o backup de volta com o nome `Jarvis`.
5. Subir novamente com:

       node server.js

   ou usando:

       Ligar JARVIS.bat

---

## 6. Restrições obrigatórias

Durante toda a implementação:

- Não apagar `server.js`.
- Não reescrever `server.js` inteiro.
- Não apagar `public/script.js`.
- Não reescrever `public/script.js` inteiro.
- Não alterar `.env`.
- Não expor chaves do `.env`.
- Não imprimir API keys em logs.
- Não alterar arquivos `.bat` sem autorização.
- Não executar `ATUALIZAR-JARVIS.bat`.
- Não executar `INSTALAR-JARVIS-v8.bat`.
- Não instalar pacotes automaticamente.
- Não alterar a porta `3000`.
- Não remover Claude.
- Não remover OpenAI.
- Não remover voz.
- Não remover Realtime.
- Não remover STT.
- Não remover TTS.
- Não remover Obsidian.
- Não remover memória.
- Não remover Computer Use.
- Não remover Excel.
- Não remover scripts Python.
- Não mudar o visual do HUD além do necessário.
- Não alterar `/api/chat` na Fase 1.
- Não criar fallback na Fase 1.
- Não criar router na Fase 1.
- Não alterar fluxo de voz na Fase 1.
- Não dizer que uma tarefa foi executada se ela não foi realmente executada.

---

## 7. Mapa técnico atual

Este mapa foi levantado a partir da análise dos arquivos reais do projeto.

### 7.1 Backend principal

Arquivo:

- `server.js`

Responsabilidades:

- Express.
- Rotas REST.
- SSE/notificações.
- Claude CLI.
- OpenAI API.
- Voz.
- Realtime.
- Memória.
- Obsidian.
- Arquivos.
- PDF.
- Excel.
- Tela.
- Computer Use.
- Browser Control.
- Health checks.

### 7.2 Frontend principal

Arquivos:

- `public/index.html`
- `public/script.js`

Responsabilidades:

- HUD.
- Cérebro 3D.
- Chat.
- Voz.
- Realtime.
- Uploads.
- Anexos.
- Arquivos.
- Status do sistema.
- Notificações.
- Obsidian viewer.
- Pet.

### 7.3 Scripts operacionais

Arquivos:

- `Ligar JARVIS.bat`
- `Desligar JARVIS.bat`
- `ATUALIZAR-JARVIS.bat`
- `INSTALAR-JARVIS-v8.bat`
- `claude-jarvis.bat`

Atenção: `ATUALIZAR-JARVIS.bat` assume caminho fixo em:

    %USERPROFILE%\Desktop\Jarvis

Mas o projeto atual está em:

    C:\Users\Leles\python\Jarvis

Portanto, não usar `ATUALIZAR-JARVIS.bat` nesta implementação.

---

## 8. Pontos reais encontrados no server.js

### 8.1 Detecção do Claude CLI

Funções existentes:

- `findClaudeCli()`
- `findClaudeCliJs()`
- `checkClaudeCliSync()`
- `checkClaudeCliAuth()`
- `checkClaudeCli()`

Responsabilidade:

- Localizar o executável `claude`.
- Localizar `cli.js` do Claude Code.
- Testar disponibilidade do Claude CLI.
- Testar autenticação.
- Atualizar `CLAUDE_CMD`.

### 8.2 Execução Claude

Funções existentes:

- `spawnColdProc(model = 'sonnet')`
- `acquireTaskProc({ model = 'sonnet' } = {})`
- `acquireWithFallback(model)`

Pontos críticos:

- `spawnColdProc()` é o cold spawn principal.
- `acquireTaskProc()` usa `spawnColdProc()`.
- `acquireWithFallback()` tenta WarmPool e depois fallback para Sonnet.

Não alterar essas funções na Fase 1.

### 8.3 Seleção de modelo

Função:

- `selectModelByComplexity(message)`

Responsável por escolher modelo conforme complexidade, agente e conteúdo do prompt.

Não alterar na Fase 1.

### 8.4 Chat principal

Rota:

- `app.post('/api/chat', async (req, res) => { ... })`

Ponto principal de chamada do Claude:

    const proc = acquireTaskProc({ model }) || acquireWithFallback(model);
    proc.stdin.write(prompt);

Não alterar `/api/chat` na Fase 1.

### 8.5 Health atual

Rota:

- `app.get('/api/health', (req, res) => { ... })`

Retorna informações sobre:

- server;
- openai;
- claude;
- chrome;
- pools;
- capabilities.

Essa rota deve continuar funcionando.

### 8.6 Voz

Rotas:

- `app.post('/api/voice-complete', async (req, res) => { ... })`
- `app.post('/api/audio-complete', async (req, res) => { ... })`
- `app.post('/api/realtime/session', async (req, res) => { ... })`
- `app.post('/api/stt', upload.single('audio'), async (req, res) => { ... })`
- `app.post('/api/tts', async (req, res) => { ... })`

Não alterar na Fase 1.

---

## 9. Pontos reais encontrados no public/script.js

### 9.1 Envio de mensagem para o chat

Função:

- `sendMessage(text, fromVoice = false)`

Chamada principal:

    fetch('/api/chat', { ... })

### 9.2 Realtime chamando tarefa

Função:

- `handleRealtimeTask(callId, argsJson)`

Também chama:

    fetch('/api/chat', { ... })

### 9.3 Health/status no HUD

Função:

- `updateHealth()`

Chama:

    fetch('/api/health')

### 9.4 Status no HTML

Em `public/index.html`, existem elementos para:

- API
- VOZ
- CLAUDE

IDs atuais:

- `bar-api-status`
- `bar-voice-status`
- `bar-claude-status`

IDs sugeridos para Codex:

- `bar-codex-status`
- `dot-codex`

### 9.5 Notificações SSE

Função/IIFE:

- `initNotifications()`

Usa:

    new EventSource('/api/notifications')

Possui handlers de:

- build-complete
- pet-mic

Não alterar na Fase 1.

---

## 10. Trechos sensíveis que não devem ser tocados na Fase 1

### 10.1 Backend

Não alterar:

- `spawnColdProc()`
- `acquireTaskProc()`
- `acquireWithFallback()`
- `selectModelByComplexity()`
- `/api/chat`
- `/api/voice-complete`
- `/api/audio-complete`
- `/api/realtime/session`
- `/api/stt`
- `/api/tts`
- `/api/computer-use/v2`
- `/api/files`
- `/api/pdf`
- `/api/excel-live`
- `/api/health/autofix`
- `notifyBuildComplete()`
- `updateProjectStatus()`
- `buildJarvisPrompt()`

### 10.2 Frontend

Não alterar:

- `sendMessage()`
- `handleRealtimeTask()`
- `startRealtime()`
- `stopRealtime()`
- `startRecording()`
- `stopRecording()`
- `transcribeAndSend()`
- `speakResponse()`
- `initNotifications()`
- handler `build-complete`
- handler `pet-mic`
- fallback Realtime do microfone
- deduplicação de `execute_task`

---

## 11. Plano de implementação por fases

A implementação deve ser feita em fases.

Não implementar tudo de uma vez.

Cada fase deve parar e aguardar validação antes de avançar.

Ordem:

1. Fase 1 — Health Check do Codex.
2. Fase 2 — Configuração do modo executor.
3. Fase 3 — HUD mostrando Codex.
4. Fase 4 — Executor Router.
5. Fase 5 — Fallback Claude para Codex.
6. Fase 6 — Criação de `.env.example`.
7. Fase 7 — Testes finais.

---

# FASE 1 — Health Check do Codex

## 12. Objetivo da Fase 1

Adicionar capacidade de o backend detectar se o Codex CLI está disponível no Windows.

Essa fase não altera execução de tarefas.

Essa fase não altera `/api/chat`.

Essa fase não cria fallback.

Essa fase não altera HUD.

Essa fase não altera frontend.

Essa fase não altera `.env`.

Essa fase não altera `.bat`.

## 12.1 Arquivo autorizado para alteração

Somente:

- `server.js`

## 12.2 Função a criar

Criar função:

- `checkCodexHealth()`

A função pode ser síncrona ou assíncrona, conforme o padrão do arquivo.

A função deve:

1. Ler `process.env.JARVIS_CODEX_CMD`.
2. Se não existir, usar `"codex"`.
3. No Windows, tentar detectar com:

       where codex

   ou:

       where <comando configurado>

4. Tentar executar:

       codex --version

5. Se `--version` falhar, tentar:

       codex --help

6. Não travar o servidor.
7. Não lançar exceção não tratada.
8. Retornar sempre objeto estruturado.

## 12.3 Retorno esperado da função

Exemplo de sucesso:

    {
      "status": "ok",
      "detail": "Codex CLI disponível",
      "command": "codex"
    }

Possíveis status:

- ok
- not_installed
- auth
- error
- unknown

## 12.4 Regras de status

### ok

Usar quando o comando foi encontrado e respondeu corretamente.

### not_installed

Usar quando o comando não existe no PATH.

Exemplo:

    {
      "status": "not_installed",
      "detail": "Codex CLI não encontrado no PATH",
      "command": "codex"
    }

### auth

Usar se a saída indicar problema de login/autenticação.

Palavras a detectar:

- auth
- authentication
- login
- sign in
- signin
- token
- unauthorized
- not authenticated
- not logged in

### error

Usar quando o comando existe, mas falha por outro motivo.

### unknown

Usar quando não foi possível determinar.

## 12.5 Nova rota

Criar rota:

- `GET /api/providers/health`

Local recomendado:

- Depois de `/api/health`.
- Antes de `/api/health/recheck`.

## 12.6 Resposta esperada da rota

Exemplo:

    {
      "server": "ok",
      "api": {
        "status": "ok",
        "detail": "OpenAI API configurada"
      },
      "voice": {
        "status": "ok",
        "detail": "Serviços de voz disponíveis"
      },
      "claude": {
        "status": "ok",
        "detail": "Claude CLI disponível"
      },
      "codex": {
        "status": "not_installed",
        "detail": "Codex CLI não encontrado no PATH",
        "command": "codex"
      },
      "executor": {
        "mode": "auto",
        "fallbackEnabled": false
      }
    }

## 12.7 Regras obrigatórias da Fase 1

- `/api/health` antigo deve continuar funcionando.
- Não alterar `/api/chat`.
- Não alterar frontend.
- Não instalar Codex.
- Não alterar `.env`.
- Não alterar `.bat`.
- Não criar router.
- Não criar fallback.
- Não tocar em voz.
- Não tocar em Realtime.
- Não tocar em Computer Use.
- Não tocar em Excel.
- Não tocar em Obsidian.

## 12.8 Validação obrigatória da Fase 1

Rodar:

    node --check server.js

Depois subir o servidor:

    node server.js

Abrir no navegador:

    http://localhost:3000/api/providers/health

## 12.9 Critério de aceite da Fase 1

A Fase 1 será aceita se:

1. `node --check server.js` passar.
2. `node server.js` subir.
3. `/api/health` antigo continuar funcionando.
4. `/api/providers/health` retornar JSON válido.
5. O JSON tiver campo `codex`.
6. Se Codex não estiver instalado, retornar `not_installed`, sem quebrar o servidor.
7. `/api/chat` continuar funcionando como antes.
8. Voz continuar funcionando como antes.

## 12.10 Relatório esperado da Fase 1

Ao terminar a Fase 1, entregar:

    FASE CONCLUÍDA: Fase 1 — Health Check do Codex

    Arquivos alterados:
    - server.js

    Funções criadas:
    - checkCodexHealth()

    Rotas criadas:
    - GET /api/providers/health

    Rotas preservadas:
    - GET /api/health
    - POST /api/chat

    Testes executados:
    - node --check server.js: OK/PENDENTE
    - node server.js: OK/PENDENTE
    - /api/providers/health: OK/PENDENTE

    Resultado Codex:
    - status: ok/not_installed/auth/error/unknown
    - detail: ...

    Riscos:
    - ...

    Próxima fase recomendada:
    - Fase 2 — Configuração do modo executor

Parar após a Fase 1 e aguardar autorização.

---

# FASE 2 — Configuração do modo executor

## 13. Objetivo da Fase 2

Adicionar controle de modo de executor, sem ainda alterar a execução principal.

Modos:

- auto
- claude
- codex
- openai

## 13.1 Arquivo autorizado para alteração

Preferencialmente:

- `server.js`

## 13.2 Variáveis futuras

Adicionar suporte lógico a:

    JARVIS_EXECUTOR_MODE=auto
    JARVIS_ENABLE_CODEX=true
    JARVIS_CODEX_CMD=codex
    JARVIS_CLAUDE_CMD=claude
    JARVIS_EXECUTOR_TIMEOUT_MS=300000

Não alterar `.env` real automaticamente.

## 13.3 Regras de modo

Se `JARVIS_EXECUTOR_MODE` não existir, usar:

- auto

Modos válidos:

- auto
- claude
- codex
- openai

Se modo inválido, voltar para `auto`.

## 13.4 Rotas a criar

Criar:

- `GET /api/executor/mode`

Resposta esperada:

    {
      "mode": "auto",
      "validModes": ["auto", "claude", "codex", "openai"]
    }

Criar:

- `POST /api/executor/mode`

Payload:

    {
      "mode": "codex"
    }

Resposta esperada:

    {
      "ok": true,
      "mode": "codex"
    }

Se inválido:

    {
      "ok": false,
      "error": "Modo inválido",
      "validModes": ["auto", "claude", "codex", "openai"]
    }

## 13.5 Regras obrigatórias da Fase 2

- Não alterar `/api/chat`.
- Não alterar execução real.
- Não criar fallback.
- Não alterar frontend ainda.
- Não alterar `.env`.
- Não alterar `.bat`.

## 13.6 Critério de aceite da Fase 2

1. `node --check server.js` passar.
2. `/api/executor/mode` retornar modo atual.
3. `POST /api/executor/mode` aceitar modo válido.
4. `POST /api/executor/mode` rejeitar modo inválido.
5. `/api/chat` continuar funcionando igual.

Parar após a Fase 2 e aguardar autorização.

---

# FASE 3 — HUD mostrando Codex

## 14. Objetivo da Fase 3

Adicionar status visual do Codex no HUD.

Hoje o HUD mostra:

- API
- VOZ
- CLAUDE

Depois deve mostrar:

- API
- VOZ
- CLAUDE
- CODEX

## 14.1 Arquivos autorizados para alteração

- `public/index.html`
- `public/script.js`

## 14.2 Alteração em public/index.html

Adicionar uma linha abaixo de CLAUDE.

IDs sugeridos:

- `dot-codex`
- `bar-codex-status`

A estrutura real deve seguir o padrão já existente no HTML.

## 14.3 Alteração em public/script.js

Na função:

- `updateHealth()`

Adicionar leitura do novo endpoint:

- `/api/providers/health`

ou adaptar com segurança o health atual para consumir o campo `codex`.

## 14.4 Estados visuais

Estados possíveis:

- OK
- OFF
- AUTH
- ERROR
- NOT INSTALLED
- UNKNOWN

Mapeamento sugerido:

- ok -> OK
- not_installed -> NOT INSTALLED
- auth -> AUTH
- error -> ERROR
- unknown -> UNKNOWN

## 14.5 Regras obrigatórias da Fase 3

- Não redesenhar o HUD inteiro.
- Não alterar fluxo de chat.
- Não alterar voz.
- Não alterar Realtime.
- Não alterar SSE.
- Não alterar `sendMessage()`.
- Não alterar `handleRealtimeTask()`.
- Não alterar `/api/chat`.

## 14.6 Critério de aceite da Fase 3

1. HUD mostra CODEX.
2. HUD não perde API, VOZ e CLAUDE.
3. `/api/providers/health` continua funcionando.
4. `/api/health` continua funcionando.
5. Chat continua funcionando.
6. Voz continua funcionando.

Parar após a Fase 3 e aguardar autorização.

---

# FASE 4 — Executor Router

## 15. Objetivo da Fase 4

Criar uma camada central para decidir qual executor usar.

Nesta fase, ainda não aplicar fallback agressivo.

A ideia é preparar a arquitetura.

## 15.1 Função desejada

Criar função:

- `executeTask({ prompt, mode, taskType, model, cwd, context, timeoutMs })`

Retorno esperado em sucesso:

    {
      "ok": true,
      "providerUsed": "claude",
      "fallbackUsed": false,
      "fallbackReason": null,
      "output": "...",
      "error": null
    }

Retorno esperado em erro:

    {
      "ok": false,
      "providerUsed": null,
      "fallbackUsed": false,
      "fallbackReason": null,
      "output": "",
      "error": {
        "type": "executor_error",
        "message": "Não consegui executar a tarefa."
      }
    }

## 15.2 Providers internos desejados

Criar ou preparar funções:

- `executeWithClaude()`
- `executeWithCodex()`
- `executeWithOpenAI()`

### executeWithClaude()

Deve reaproveitar o fluxo existente do Claude.

Não duplicar de forma perigosa `spawnColdProc()`.

### executeWithCodex()

Deve preparar execução Codex, mas sem assumir que Codex CLI existe.

Se Codex CLI não existir, retornar erro estruturado.

### executeWithOpenAI()

Deve usar OpenAI apenas para resposta textual/planejamento, salvo se já existir mecanismo seguro de escrita controlada.

## 15.3 Regras obrigatórias da Fase 4

- Não quebrar streaming atual.
- Não remover ACK imediato.
- Não remover notificações.
- Não remover `notifyBuildComplete()`.
- Não remover `updateProjectStatus()`.
- Não alterar voz.
- Não alterar Realtime.
- Não alterar Computer Use.
- Não alterar Excel.
- Não afirmar execução sem confirmação.

## 15.4 Critério de aceite da Fase 4

1. Código passa em `node --check server.js`.
2. `/api/chat` ainda funciona.
3. Claude ainda funciona.
4. Codex ainda aparece no health.
5. Nenhuma funcionalidade existente foi removida.

Parar após a Fase 4 e aguardar autorização.

---

# FASE 5 — Fallback Claude para Codex

## 16. Objetivo da Fase 5

Quando Claude falhar em modo `auto`, tentar Codex.

## 16.1 Condições de fallback

Fazer fallback quando Claude retornar:

- limit
- auth
- off
- timeout
- empty_output
- process_error

Não fazer fallback se o usuário escolheu explicitamente:

- mode = claude

## 16.2 Fluxo desejado

    Usuário pede tarefa
      ↓
    /api/chat
      ↓
    modo auto
      ↓
    tenta Claude
      ↓
    Claude OK?
      ├── sim -> responde normalmente
      └── não -> tenta Codex
              ↓
              Codex OK?
              ├── sim -> responde com saída do Codex
              └── não -> erro amigável

## 16.3 Mensagens amigáveis

Claude em limite:

    Claude atingiu limite. Vou tentar executar pelo Codex.

Claude sem autenticação:

    Meu executor Claude está sem autenticação. Vou tentar executar pelo Codex.

Claude indisponível:

    Claude está indisponível no momento. Vou tentar executar pelo Codex.

Codex não instalado:

    Codex não está disponível no terminal deste ambiente. Verifique instalação/login do Codex CLI.

Codex sem autenticação:

    Codex está instalado, mas parece não estar autenticado.

Ambos falharam:

    Não consegui executar a tarefa porque Claude e Codex estão indisponíveis no momento.

## 16.4 Regra crítica

Nunca afirmar que arquivo foi criado se não foi.

Nunca afirmar que código foi alterado se não foi.

Nunca afirmar que a tarefa foi concluída se o executor retornou erro.

## 16.5 Logs desejados

Adicionar logs sem vazar segredos:

    [JARVIS][executor] mode=auto taskType=code
    [JARVIS][claude] executing
    [JARVIS][claude] failed errorType=limit
    [JARVIS][executor] fallback=codex reason=claude_limit
    [JARVIS][codex] executing
    [JARVIS][executor] completed provider=codex

Não logar:

- OPENAI_API_KEY
- ANTHROPIC_API_KEY
- tokens
- credenciais
- conteúdo completo do .env

## 16.6 Critério de aceite da Fase 5

1. Modo `auto` tenta Claude.
2. Se Claude falhar por erro conhecido, tenta Codex.
3. Modo `claude` não faz fallback.
4. Modo `codex` tenta Codex diretamente.
5. Se Codex não existir, retorna erro amigável.
6. Não quebra voz.
7. Não quebra Realtime.
8. Não quebra HUD.
9. Não mente sobre execução.

Parar após a Fase 5 e aguardar autorização.

---

# FASE 6 — Criação de .env.example

## 17. Objetivo da Fase 6

Criar um arquivo `.env.example` seguro, sem chaves reais.

## 17.1 Arquivo a criar

- `.env.example`

## 17.2 Conteúdo sugerido

    # =============================================================================
    # JARVIS - EXEMPLO DE CONFIGURAÇÃO
    # =============================================================================

    # Porta do servidor local
    PORT=3000

    # OpenAI API usada para voz, STT, TTS, Realtime, GPT e embeddings
    OPENAI_API_KEY=sk-COLOQUE_SUA_CHAVE_AQUI

    # Obsidian
    OBSIDIAN_VAULT=C:\Jrleles_Obsidian

    # Claude
    CLAUDE_CLI_PATH=

    # Executor híbrido
    JARVIS_EXECUTOR_MODE=auto
    JARVIS_ENABLE_CODEX=true
    JARVIS_CODEX_CMD=codex
    JARVIS_CLAUDE_CMD=claude
    JARVIS_EXECUTOR_TIMEOUT_MS=300000

## 17.3 Regras obrigatórias da Fase 6

- Não copiar valores reais do `.env`.
- Não abrir `.env` real para copiar segredo.
- Não alterar `.env` real automaticamente.
- Não expor chave no relatório.

## 17.4 Critério de aceite da Fase 6

1. `.env.example` criado.
2. Não contém chave real.
3. Não altera `.env`.
4. Servidor continua funcionando.

Parar após a Fase 6 e aguardar autorização.

---

# FASE 7 — Testes finais

## 18. Objetivo da Fase 7

Validar o sistema completo após as alterações.

## 18.1 Teste 1 — Sintaxe

Rodar:

    node --check server.js

Resultado esperado:

    sem erros

## 18.2 Teste 2 — Subir servidor

Rodar:

    node server.js

Abrir:

    http://localhost:3000

## 18.3 Teste 3 — Health antigo

Abrir:

    http://localhost:3000/api/health

Resultado esperado:

    JSON válido

## 18.4 Teste 4 — Health novo

Abrir:

    http://localhost:3000/api/providers/health

Resultado esperado:

    JSON válido contendo codex

## 18.5 Teste 5 — Modo executor

Abrir:

    http://localhost:3000/api/executor/mode

Resultado esperado:

    {
      "mode": "auto",
      "validModes": ["auto", "claude", "codex", "openai"]
    }

## 18.6 Teste 6 — HUD

Abrir:

    http://localhost:3000

Verificar se aparecem:

- API
- VOZ
- CLAUDE
- CODEX

## 18.7 Teste 7 — Chat simples

Enviar:

    Que horas são?

Resultado esperado:

    resposta local ou resposta rápida sem quebrar

## 18.8 Teste 8 — Tarefa com arquivo

Enviar:

    Crie um arquivo chamado TESTE-JARVIS-CODEX.txt dentro de Documents and Projects dizendo qual executor foi usado.

Resultado esperado:

1. Arquivo criado.
2. Resposta coerente.
3. Log indicando executor usado.

## 18.9 Teste 9 — Modo Codex

Selecionar ou configurar:

    mode = codex

Enviar:

    Crie um arquivo chamado TESTE-CODEX-JARVIS.txt dentro de Documents and Projects dizendo que foi criado pelo executor Codex.

Se Codex não estiver instalado, resultado esperado:

    erro amigável informando Codex não instalado

## 18.10 Teste 10 — Modo Claude

Selecionar ou configurar:

    mode = claude

Enviar:

    Crie um arquivo chamado TESTE-CLAUDE-JARVIS.txt dentro de Documents and Projects dizendo que foi criado pelo executor Claude.

Resultado esperado:

1. Claude tenta executar.
2. Se falhar, retorna erro amigável.
3. Não faz fallback em modo `claude`.

## 18.11 Teste 11 — Voz

Testar comando de voz simples.

Resultado esperado:

1. Microfone captura.
2. STT funciona.
3. Resposta aparece.
4. TTS funciona.
5. Realtime não quebra.

## 18.12 Teste 12 — Codex ausente

Se Codex CLI não existir, confirmar que o sistema mostra:

    not_installed

sem quebrar servidor, HUD, voz ou chat.

---

## 19. Entrega esperada após cada fase

Após cada fase, entregar relatório neste formato:

    FASE CONCLUÍDA: <nome da fase>

    Arquivos alterados:
    - ...

    Funções criadas/alteradas:
    - ...

    Rotas criadas/alteradas:
    - ...

    Rotas preservadas:
    - ...

    Testes executados:
    - node --check server.js: OK/PENDENTE
    - node server.js: OK/PENDENTE
    - /api/health: OK/PENDENTE
    - /api/providers/health: OK/PENDENTE
    - /api/chat: OK/PENDENTE
    - voz: OK/PENDENTE

    Resultado:
    - ...

    Riscos:
    - ...

    Próxima fase recomendada:
    - ...

    Parando aqui para validação do usuário.

Não avançar para a próxima fase sem autorização explícita.

---

## 20. Primeira tarefa autorizada

A primeira tarefa autorizada é somente:

- Fase 1 — Health Check do Codex

Escopo autorizado:

- Alterar `server.js`.
- Criar `checkCodexHealth()`.
- Criar `GET /api/providers/health`.
- Preservar `/api/health`.
- Rodar `node --check server.js`.

Escopo não autorizado na Fase 1:

- Não alterar `/api/chat`.
- Não alterar `public/script.js`.
- Não alterar `public/index.html`.
- Não alterar `.env`.
- Não alterar `.bat`.
- Não criar fallback.
- Não instalar Codex.
- Não criar router.
- Não mexer na voz.
- Não mexer no Realtime.
- Não mexer no Computer Use.
- Não mexer no Excel.
- Não mexer no Obsidian.

---

## 21. Prompt para executar a Fase 1

Quando o usuário autorizar, executar exatamente:

    Implemente somente a Fase 1 do PRD.md.

    Regras:

    1. Altere apenas server.js.
    2. Crie checkCodexHealth().
    3. Crie GET /api/providers/health.
    4. Não altere /api/chat.
    5. Não altere voz.
    6. Não altere frontend.
    7. Não altere .env.
    8. Não altere .bat.
    9. Não instale pacotes.
    10. Não avance para Fase 2.

    Depois rode node --check server.js e entregue relatório.

---

## 22. Critério final de sucesso do projeto completo

O projeto completo será considerado concluído quando:

1. JARVIS continuar subindo em `localhost:3000`.
2. Claude continuar funcionando.
3. OpenAI continuar funcionando.
4. Voz continuar funcionando.
5. Realtime continuar funcionando.
6. HUD mostrar Codex.
7. `/api/providers/health` mostrar Codex.
8. Executor puder ser configurado como `auto`, `claude`, `codex` ou `openai`.
9. Em modo `auto`, Claude for usado quando disponível.
10. Em modo `auto`, Codex for usado quando Claude falhar.
11. Se Codex não estiver instalado, o JARVIS não quebrar.
12. Se Claude estiver em limite, o JARVIS tentar Codex.
13. Nenhuma chave vazar.
14. Nenhum `.bat` perigoso ser executado sem autorização.
15. O usuário conseguir voltar para a versão original usando a pasta backup.

---

## 23. Observação final para o Codex

Este projeto é sensível porque controla arquivos, voz, navegador, tela, mouse, teclado, Excel, PDF, memória, Obsidian e execução por Claude CLI.

Portanto:

- Trabalhe em fases.
- Faça alterações pequenas.
- Não refatore tudo.
- Não reescreva arquivos inteiros.
- Não execute scripts perigosos.
- Não avance sem autorização.
- Preserve o funcionamento atual.
