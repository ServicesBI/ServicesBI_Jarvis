# DOCUMENTAÇÃO — Integração Claude + Codex no JARVIS

## 1. Visão geral

O JARVIS agora trabalha com três camadas principais de execução e inteligência:

- Claude CLI;
- Codex CLI;
- OpenAI API;
- modo AUTO;
- modo CLAUDE;
- modo CODEX.

O objetivo da integração é manter o fluxo Claude existente preservado, adicionar Codex como executor controlado e permitir fallback seguro quando o modo AUTO estiver ativo.

## 2. Modos de execução

### AUTO

- Tenta Claude primeiro.
- Se Claude falhar por limite, erro, autenticação, timeout, saída vazia ou erro de processo, cai para Codex.
- `fallbackEnabled=true` indica que o fallback está disponível no modo AUTO.

### CLAUDE

- Usa somente Claude.
- Não cai para Codex automaticamente.
- Preserva o fluxo antigo do JARVIS.

### CODEX

- Usa somente Codex.
- No `/api/chat`, mantém segurança controlada.
- Escrita pelo chat exige confirmação explícita e continua limitada a `Documents and Projects`.

### OPENAI

- Modo reservado/estrutural.
- Não é o foco principal neste momento.

## 3. Rotas criadas

### GET /api/providers/health

Retorna o estado dos provedores e do executor atual, incluindo:

- API;
- voz;
- Claude;
- Codex;
- modo executor;
- modos válidos;
- `fallbackEnabled`.

### GET /api/executor/mode

Retorna o modo executor atual e os modos válidos.

### POST /api/executor/mode

Altera o modo executor em memória.

Modos aceitos:

- `auto`;
- `claude`;
- `codex`;
- `openai`.

### POST /api/executor/dry-run

Executa roteamento passivo.

Não executa tarefas, não cria arquivos e não chama o executor real para modificar nada.

### POST /api/executor/codex-test

Executa teste textual isolado do Codex.

Usa Codex em modo controlado e sem escrita.

### POST /api/executor/codex-write-test

Executa teste isolado de escrita pelo Codex somente dentro de `Documents and Projects`.

### GET /api/executor/codex-write-pending

Lista pendências de escrita criadas pelo chat.

Não expõe o conteúdo completo do arquivo.

### POST /api/chat

Além do fluxo normal, aceita:

- `CONFIRMAR_ESCRITA_CODEX <codigo>`;
- `CANCELAR_ESCRITA_CODEX <codigo>`.

Esses comandos confirmam ou cancelam uma escrita pendente.

## 4. Segurança de escrita

- Escrita via Codex pelo chat exige confirmação explícita.
- Escrita sem confirmação não acontece.
- Escrita é limitada a `Documents and Projects`.
- Extensões permitidas:
  - `.txt`;
  - `.md`;
  - `.html`;
  - `.json`;
  - `.csv`.
- Path traversal é bloqueado.
- Caminhos absolutos são bloqueados.
- `.env` é bloqueado.
- `.bat`, `.cmd`, `.ps1` e `.exe` são bloqueados.
- Arquivos do projeto não são editados por essa fase.

## 5. Fluxo de confirmação

Usuário:

```text
crie um arquivo chamado RELATORIO.txt com o conteúdo: teste
```

Jarvis:

```text
Pedido de escrita pendente.

Arquivo: RELATORIO.txt
Destino: Documents and Projects
Expira em: 10 minutos

Para confirmar, envie:
CONFIRMAR_ESCRITA_CODEX ABC123

Para cancelar, envie:
CANCELAR_ESCRITA_CODEX ABC123
```

Confirmação:

```text
CONFIRMAR_ESCRITA_CODEX ABC123
```

Cancelamento:

```text
CANCELAR_ESCRITA_CODEX ABC123
```

## 6. Como testar

### GET executor mode

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/executor/mode" -Method Get
```

### POST mode=auto

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/executor/mode" -Method Post -ContentType "application/json" -Body '{"mode":"auto"}'
```

### POST mode=claude

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/executor/mode" -Method Post -ContentType "application/json" -Body '{"mode":"claude"}'
```

### POST mode=codex

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/executor/mode" -Method Post -ContentType "application/json" -Body '{"mode":"codex"}'
```

### POST /api/chat com teste simples

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/chat" -Method Post -ContentType "application/json" -Body '{"message":"responda apenas: TESTE_OK","language":"BR"}'
```

### POST /api/executor/codex-test

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/executor/codex-test" -Method Post -ContentType "application/json" -Body '{"prompt":"responda apenas: CODEX_OK","timeoutMs":30000}'
```

### POST /api/executor/codex-write-test

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/executor/codex-write-test" -Method Post -ContentType "application/json" -Body '{"filename":"TESTE_WRITE.txt","content":"Teste de escrita controlada."}'
```

### GET /api/executor/codex-write-pending

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/executor/codex-write-pending" -Method Get
```

## 7. Estado final validado

A Fase 7 validou:

- `/api/health` OK;
- `/api/providers/health` OK;
- Codex OK;
- Claude preservado;
- AUTO OK;
- CODEX OK;
- CLAUDE OK;
- escrita confirmada OK;
- cancelamento OK;
- path traversal bloqueado;
- extensão perigosa bloqueada;
- Realtime endpoint OK;
- TTS OK;
- arquivos/download/view OK.

## 8. Pendências futuras

- Testar voz real/microfone manualmente.
- Melhorar visual das pendências no HUD, se desejado.
- Implementar botão de desktop/launcher melhorado.
- Criar futura edição segura de projetos reais.
- Criar futura camada única de segurança para Claude e Codex.
- Criar futura documentação técnica dos agentes AIOX-CORE.

## 9. Regra de ouro

- Não liberar edição de projeto real sem backup, Git ou checkpoint.
- Não liberar escrita fora de pasta autorizada.
- Não mexer em `.env` sem autorização explícita.
- Não executar scripts destrutivos sem confirmação.
