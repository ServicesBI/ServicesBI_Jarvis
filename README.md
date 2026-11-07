# J.A.R.V.I.S. — ServicesBI

### Just A Rather Very Intelligent System

**Seu assistente pessoal de inteligência artificial. Sua central de comando. Seu parceiro de desenvolvimento.**

![ServicesBI JARVIS HUD](docs/assets/jarvis-hud-preview.png)

**JARVIS ServicesBI** é um projeto de assistente inteligente para Windows, desenvolvido para conectar conversação por voz, agentes de IA, programação assistida, memória contextual e automações em uma experiência visual futurista.

Mais do que responder perguntas, o objetivo é transformar instruções em tarefas executáveis, utilizando ferramentas e agentes especializados para analisar problemas, desenvolver software, trabalhar com arquivos e auxiliar nas operações do computador.

**Desenvolvido pela ServicesBI.**

[Website ServicesBI](https://servicesbi.com.br) · [Página do JARVIS](https://servicesbi.com.br/jarvis/)

---

## Visão geral

O JARVIS foi concebido para atuar como uma central de inteligência e operações pessoais.

A plataforma combina diferentes capacidades:

- **Conversação inteligente:** interação por texto e voz com serviços de IA.
- **Programação assistida:** integração com Codex CLI e Claude Code CLI.
- **Agentes especializados:** divisão de responsabilidades para análise, desenvolvimento, arquitetura e operações.
- **Memória contextual:** armazenamento de histórico e informações relevantes.
- **Automação do Windows:** interação com aplicativos, arquivos e ferramentas do computador.
- **Análise de dados:** recursos voltados para Excel, relatórios e Power BI.
- **Interface futurista:** HUD inspirado em sistemas de comando de ficção científica.
- **Execução controlada:** verificações, permissões e confirmação de operações sensíveis.

O objetivo central é construir um assistente capaz de compreender solicitações, selecionar os recursos adequados, acompanhar a execução e apresentar resultados verificáveis.

---

## O principal diferencial: IA aplicada à programação

Um dos principais objetivos do ServicesBI JARVIS é permitir que o usuário solicite tarefas de desenvolvimento por linguagem natural.

Por meio das integrações com **OpenAI, Codex e Claude**, o sistema está sendo desenvolvido para atuar durante diferentes etapas do ciclo de engenharia de software:

1. Interpretar uma solicitação.
2. Identificar o projeto e os arquivos relevantes.
3. Selecionar o agente de programação.
4. Analisar código e propor alterações.
5. Executar tarefas autorizadas em um ambiente controlado.
6. Validar resultados por testes e revisão.
7. Informar o resultado e registrar o contexto da tarefa.

### Exemplo de experiência desejada

> **Usuário:** "JARVIS, analise meu projeto no VS Code, identifique o problema na autenticação, utilize o Codex para implementar uma correção e peça ao Claude para revisar o resultado."

**Fluxo arquitetural proposto:**

```text
                 USUÁRIO
                    |
              Voz ou texto
                    |
                    v
              JARVIS CORE
                    |
           Orquestrador de tarefas
                    |
        +-----------+-----------+
        |                       |
        v                       v
    CODEX CLI              CLAUDE CODE
  Implementação          Análise e revisão
        |                       |
        +-----------+-----------+
                    |
                    v
          CONTROLE DE EXECUÇÃO
        Permissões / Git / Testes
                    |
                    v
            RESULTADO VALIDADO
                    |
                    v
              JARVIS HUD
```

**Estado atual:** as integrações de chat com Codex e Claude estão implementadas. Fluxos completos de programação autônoma, com edição isolada, sessões persistentes, revisão cruzada e testes coordenados, fazem parte da evolução planejada.

---

## Voz inteligente com OpenAI

O projeto inclui integração com serviços de voz da OpenAI para proporcionar uma experiência de conversação natural.

### Recursos presentes no código

- Sessões de áudio com a OpenAI Realtime API.
- Comunicação WebRTC.
- Captura de áudio pelo microfone.
- Detecção de atividade de voz.
- Reconhecimento de fala com Whisper.
- Síntese de voz com a API da OpenAI.
- Suporte à interação em português brasileiro.
- Alternativas de captura e reprodução de áudio.

A arquitetura permite utilizar a voz como interface para conversar com o assistente e encaminhar comandos para o sistema de execução.

A disponibilidade dos recursos depende da configuração da API, da compatibilidade dos modelos e do ambiente local.

**Direção futura:** ativação por voz e por duas palmas, resposta falada de baixa latência e integração completa entre conversação, ferramentas e HUD.

---

## Agentes especializados

O projeto mantém uma arquitetura de agentes que distribui responsabilidades de acordo com o tipo de solicitação.

O repositório público documenta o conceito **AIOX-CORE**, com 12 papéis especializados:

| Agente | Especialidade | Responsabilidade |
|---|---|---|
| Orion | Master | Coordenação estratégica |
| Aria | Architect | Arquitetura de sistemas |
| Dex | Dev | Desenvolvimento de software |
| Dara | Data | Dados, métricas e análises |
| Gage | DevOps | Infraestrutura e automações |
| Uma | UX | Experiência e interface |
| Morgan | PM | Gestão de projetos |
| Pax | PO | Requisitos e produto |
| Atlas | Analyst | Diagnóstico e análise |
| Quinn | QA | Qualidade e testes |
| River | SM | Organização de processos |
| Craft | Squad Creator | Composição de equipes |

**Nota de arquitetura:** esses papéis representam a estrutura conceitual documentada no repositório. A auditoria da versão local FastAPI identificou outro catálogo operacional de oito agentes. A consolidação dos catálogos e a validação da execução multiagente fazem parte da modernização do projeto.

---

## Integração Codex + Claude

O JARVIS possui integração com ferramentas de programação baseadas em linha de comando:

**Codex CLI**

- Consulta e análise de código.
- Execução de tarefas textuais de desenvolvimento.
- Verificação de disponibilidade e autenticação.
- Modos de execução controlados.
- Restrições de diretório e permissões.

**Claude Code CLI**

- Análise de arquitetura e projetos.
- Apoio à resolução de problemas.
- Interpretação de requisitos.
- Revisão e planejamento técnico.
- Participação em fluxos de execução coordenados.

### Modos de execução

O projeto contempla a seleção de executores conforme sua versão e configuração:

| Modo | Finalidade |
|---|---|
| AUTO | Seleção e fallback entre executores |
| CODEX | Utilizar o Codex |
| CLAUDE | Utilizar o Claude Code |

A política exata do modo AUTO depende da implementação utilizada. A versão pública Node.js e a versão local FastAPI auditada apresentam diferenças nesse comportamento.

### Evolução planejada

- Sessões persistentes por projeto.
- Execução em branches ou worktrees Git isolados.
- Acompanhamento de progresso e logs.
- Revisão de código entre agentes.
- Execução de testes automatizados.
- Aprovação antes da integração de alterações.
- Retomada de tarefas interrompidas.

---

## Memória e conhecimento

O JARVIS possui componentes para armazenamento e recuperação de contexto.

Entre os mecanismos utilizados ou documentados estão:

- Histórico de conversas.
- Memória persistente em Markdown e JSON.
- Embeddings para busca semântica.
- Organização contextual de projetos.
- Integração com Obsidian.
- Estrutura de conhecimento denominada Mega-Brain.

Na auditoria da versão local, parte da memória histórica foi identificada como legada e ainda não conectada integralmente ao runtime FastAPI atual.

**Próxima etapa:** consolidar a memória em uma arquitetura persistente e pesquisável, preservando a origem das informações e evitando duplicidades.

---

## Automação do computador

O JARVIS inclui módulos destinados à interação com o Windows e suas ferramentas.

### Capacidades identificadas

| Área | Recursos |
|---|---|
| Sistema operacional | Abertura de aplicativos e gerenciamento de tarefas |
| Arquivos | Localização, leitura e criação controlada |
| Navegador | Interação e automação por ferramentas específicas |
| Interface gráfica | Mouse, teclado e captura de tela |
| Word | Criação e manipulação de documentos |
| Excel | Leitura, criação e geração de planilhas |
| Power BI | Abertura e integração com fluxos específicos |
| IA visual | Análise de informações capturadas da tela |
| Conhecimento | Consulta a estruturas e notas do Obsidian |

Algumas capacidades dependem de programas instalados, serviços externos, permissões locais e configurações específicas.

O projeto prioriza operações controladas, evitando acesso irrestrito a arquivos e comandos sem validação.

---

## Interface futurista

A identidade visual do JARVIS combina elementos de uma central de comando com uma interface de inteligência artificial.

### Conceitos visuais

- HUD tecnológico.
- Núcleo visual de inteligência.
- Painéis de status.
- Indicação de estados de voz.
- Visualização de agentes.
- Monitoramento de tarefas.
- Feedback de execução.
- Identidade visual ServicesBI.

O desenvolvimento do **JARVIS 3.0** prevê uma evolução dessa experiência com React, Three.js e Electron, além de painéis dinâmicos e visualizações de atividades.

A nova interface deverá permitir acompanhar não apenas conversas, mas também o trabalho executado pelos agentes de programação.

---

## Arquitetura e evolução tecnológica

O projeto possui diferentes gerações de implementação.

### Versão presente no repositório público

A versão atualmente publicada inclui:

```text
ServicesBI_Jarvis/
├── agents/
├── docs/
├── launcher/
├── pet/
├── public/
│   ├── index.html
│   ├── script.js
│   └── style.css
├── system/
├── tests/
├── server.js
├── package.json
├── requirements.txt
└── README.md
```

O backend publicado utiliza **Node.js e Express**, acompanhado por módulos auxiliares em Python.

### Arquitetura local em evolução

Uma auditoria técnica também identificou uma implementação modular em **Python e FastAPI**, com serviços específicos para:

- Voz e OpenAI.
- Codex e Claude.
- Agentes e orquestração.
- Action Engine.
- Políticas de execução.
- Gerenciamento de tarefas.
- Automação.
- Power BI.
- Persistência.

Essa estrutura local não deve ser presumida como integralmente disponível nesta branch pública.

### JARVIS 3.0

A evolução planejada considera a combinação de:

- Frontend holográfico em React e Three.js.
- Aplicativo desktop com Electron.
- Backend modular em FastAPI.
- Orquestração centralizada.
- Plugins e ferramentas.
- Integração Codex/Claude.
- Voz OpenAI Realtime.
- Memória persistente.
- Execução segura de tarefas.

A migração será feita gradualmente, com validação antes da substituição dos componentes existentes.

---

## Segurança e execução responsável

Um assistente que opera arquivos e ferramentas de desenvolvimento precisa trabalhar com limites claros.

As diretrizes do projeto incluem:

- Confirmação para operações sensíveis.
- Restrição de diretórios autorizados.
- Proteção de credenciais e arquivos de configuração.
- Verificação de resultados.
- Registros de execução.
- Ambientes isolados para edição de código.
- Testes antes de incorporar alterações.
- Preservação de histórico e possibilidade de recuperação.

As permissões ainda estão sendo consolidadas entre as diferentes versões do JARVIS.

**Importante:** não disponibilize chaves de API, tokens, senhas, arquivos `.env` ou dados pessoais no repositório. O histórico de commits também deve ser verificado antes da publicação de informações sensíveis.

---

## Roadmap — JARVIS 3.0

| Fase | Objetivo | Estado |
|---|---|---|
| 1 | Auditoria dos sistemas existentes | Análise estática realizada |
| 2 | Preservação do backend legado | Planejado |
| 3 | Integração com interface holográfica | Em avaliação |
| 4 | Modernização das sessões Codex/Claude | Planejado |
| 5 | Execução de programação com Git e testes | Planejado |
| 6 | Unificação da memória | Planejado |
| 7 | Integração das automações e Power BI | Planejado |
| 8 | Ativação por voz e duas palmas | Planejado |
| 9 | Validação integrada e estabilização | Planejado |

A prioridade é evoluir o JARVIS sem perder os recursos já desenvolvidos.

---

## Tecnologias

**Backend e automação**
- Node.js
- Express
- Python
- FastAPI (implementação local em evolução)
- Windows Automation

**IA e agentes**
- OpenAI API
- OpenAI Realtime API
- OpenAI Whisper
- Codex CLI
- Claude Code CLI

**Interface**
- HTML
- CSS
- JavaScript
- React / Three.js / Electron (evolução JARVIS 3.0)

**Dados e conhecimento**
- JSON
- Markdown
- Obsidian
- Embeddings
- SQLite e PostgreSQL em arquiteturas de evolução

---

## Estado do projeto

**Projeto em desenvolvimento ativo de arquitetura e modernização.**

O repositório contém código e documentação de uma geração funcional do JARVIS, mas nem todas as capacidades descritas estão disponíveis ou validadas em todas as versões.

O JARVIS 3.0 representa uma evolução arquitetural, com foco em uma interface mais moderna e na capacidade de coordenar agentes para executar tarefas de programação e automação com segurança.

---

## Sobre a ServicesBI

A **ServicesBI** desenvolve soluções voltadas à inteligência de dados, automação, desenvolvimento de software e aplicação prática de inteligência artificial.

O JARVIS representa uma iniciativa de pesquisa e desenvolvimento para integrar essas áreas em um assistente operacional inteligente.

**Website:** https://servicesbi.com.br

**JARVIS:** https://servicesbi.com.br/jarvis/

**GitHub:** https://github.com/ServicesBI/ServicesBI_Jarvis

---

### J.A.R.V.I.S. — ServicesBI

**Inteligência que conversa. Agentes que colaboram. Tecnologia que executa.**

*Construindo uma nova forma de interagir com computadores, sistemas e inteligência artificial.*
