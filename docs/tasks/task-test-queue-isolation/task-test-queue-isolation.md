# Task — Isolar a fila `video-processing` dos testes do worker

## Objective

As suítes de integração e e2e de vídeo usam o mesmo Redis que o `video-worker` consome. Com o worker de pé, a suíte falha de forma não determinística. Esta tarefa faz a suíte passar com o stack completo rodando, sem `docker compose stop video-worker`.

---

## Context

Origem: SI-03.9 da fase 03 (commit `51a6c6e`, branch `feature/phase-03-videos`). Hoje o `nestjs-project/CLAUDE.md` manda parar o worker antes de rodar os testes de vídeo; isso é um workaround.

Evidências observadas:

1. `video-processing.producer.integration-spec.ts` esperava `waiting: 1` e recebeu `waiting: 0`. O worker consumiu o job antes da asserção.
2. Log do worker com o stack de pé: `Missing key for job <id>. moveToDelayed`. O `obliterate` do teste apagou jobs que o worker já tinha em mãos.

O worker de desenvolvimento e a suíte usam a mesma fila lógica (`video-processing`) e o mesmo Redis. O problema é de isolamento, não de lógica de negócio.

---

## Options

- **A. Prefixo de chaves do BullMQ por ambiente** (recomendada). `prefix` nas opções da fila, vindo de uma variável de ambiente (ex.: `QUEUE_PREFIX`). Os testes usam outro prefixo; o worker de desenvolvimento continua no padrão. Isola a suíte inteira, sem mudar o comportamento do worker real.
- **B. Índice de DB do Redis separado para teste** (`connection.db`). Isola as chaves, mas exige outro índice configurado nos dois lados e não resolve o caso de quem roda testes com `REDIS_DB` apontando para o índice do worker.
- **C. Pausar a fila em `beforeEach`** (`queue.pause()`), retomando em `afterEach`. Frágil: a pausa é global ao nome da fila, e suítes que não pausam (service, e2e de upload e de leitura) continuam expostas.

Recomendação: **A**. Antes de implementar, confirmar a opção `prefix` de `QueueOptions`/`WorkerOptions` na versão instalada do `bullmq` (6.5.x) pelo context7, conforme o `CLAUDE.md` raiz.

---

## Step Implementations

### SI-1 — Prefixo da fila por ambiente

- Em `src/config/queue.config.ts`, ler `QUEUE_PREFIX` (default: ausente, comportamento atual do BullMQ).
- Em `src/video-processing/video-processing-queue.module.ts`, passar o prefixo para a fila registrada.
- Garantir que o `VideoProcessingProcessor` e o `VideoProcessingProducer` usam a mesma fila configurada.

**Tests:** `video-processing-queue.module.integration-spec.ts` — a fila resolvida tem o prefixo da configuração.

**Dependencies:** nenhuma.

### SI-2 — Suítes de vídeo usam prefixo próprio

- Definir `QUEUE_PREFIX` para as suítes de teste num `setupFiles` do Jest (ex.: `src/test/queue-prefix.ts`, com `process.env.QUEUE_PREFIX ??= 'test'`), em `package.json` e em `test/jest-e2e.json`. Assim ninguém precisa lembrar de exportar a variável.
- A limpeza das suítes (`obliterate`) passa a afetar só o prefixo de teste.

**Tests:** `video-processing.producer.integration-spec.ts` e `videos-upload` / `videos-read` e2e continuam passando; acrescentar asserção de que a fila de teste tem o prefixo `test`.

**Dependencies:** SI-1.

### SI-3 — Verificação com o worker de pé

- Subir o `video-worker` (`docker compose up -d video-worker`) e rodar a suíte completa: unit/integration e e2e, sem parar o worker.
- Confirmar que o worker de desenvolvimento continua consumindo a fila padrão: enfileirar um job manualmente com o prefixo padrão e ver o worker processá-lo.

**Dependencies:** SI-1, SI-2.

---

## Acceptance

- A suíte de unit/integration e a e2e passam com o `video-worker` em execução.
- O worker de desenvolvimento processa jobs enfileirados no prefixo padrão.
- `nestjs-project/CLAUDE.md`: a seção "Stop the worker before running the video suites" é removida.

---

## Out of scope

- Separar a instância do Redis para testes.
- Mudar o contrato da fila (`video-processing`, `process-video`) ou o formato dos jobs.
- Stop/start gracioso do worker (`docker compose stop video-worker` esperando o job em voo), que é pendência da SI-03.7.
