# task-test-queue-isolation — Progress

**Status:** completed
**SIs:** 3/3 completed

### SI-1 — Prefixo da fila por ambiente
- **Status:** completed
- **Tests:** 3 novos (`src/config/queue.config.spec.ts`: 2; `src/video-processing/video-processing-queue.module.integration-spec.ts`: +1 prefixo); suítes de fila, worker e processor passando (19/19); `tsc --noEmit` exit 0
- **Observations:**
  - `queue.config` lê `QUEUE_PREFIX` com default `bull` (o padrão do BullMQ): sem a variável, nada muda.
  - A fila passou de `BullModule.registerQueue` para `registerQueueAsync`, que recebe o prefixo pela configuração. O `@Processor` não precisou de mudança: segundo a documentação do `@nestjs/bullmq`, o worker herda o prefixo das opções da fila registrada, então produtor e worker ficam sempre iguais.
  - Verificado no Redis: com `QUEUE_PREFIX=test`, as chaves da fila ficam em `test:video-processing:*`; sem a variável, em `bull:video-processing:*`.
  - `QUEUE_PREFIX` documentado no `.env.example`, com o default explicado.
  - A suíte completa (unit/integração e e2e) foi rodada depois desta SI.

### SI-2 — Suítes de vídeo usam prefixo próprio
- **Status:** completed
- **Tests:** 1 novo (asserção de prefixo `test` em `video-processing.producer.integration-spec.ts`); full unit/integração 229/229 em 40 suites; full e2e 71/71 em 5 suites; `tsc --noEmit` exit 0; `npm run lint` exit 0 (0 errors)
- **Observations:**
  - `src/test/queue-prefix.ts` roda como `setupFiles` depois do `dotenv/config` e força `QUEUE_PREFIX=test`. Forçar (e não usar `??=`) garante que um `.env` com outro prefixo não vaze para os testes.
  - Ligado nos dois configs do Jest: `package.json` (`<rootDir>/test/queue-prefix.ts`, rootDir `src`) e `test/jest-e2e.json` (`<rootDir>/../src/test/queue-prefix.ts`). No e2e o `<rootDir>` é a pasta `test/`, por isso o `../`. Na primeira tentativa o caminho estava errado e o e2e não carregava; corrigido e rodado de novo.
  - Com o worker parado, as chaves de teste vão para `test:video-processing:*`, separadas das do worker de desenvolvimento (`bull:`).
  - Com o worker parado, as chaves de teste vão para `test:video-processing:*`, separadas das do worker de desenvolvimento (`bull:`).

### SI-3 — Verificação com o worker de pé
- **Status:** completed
- **Tests:** full unit/integração 229/229 em 40 suites e full e2e 71/71 em 5 suites, com o `video-worker` de pé; `tsc --noEmit` exit 0 (SI-2); `npm run lint` exit 0 (0 errors)
- **Observations:**
  - Sonda de isolamento com o worker de pé: um job enfileirado no prefixo `bull` foi consumido (aparece em `bull:video-processing:completed`); um job no prefixo `test` foi ignorado (não aparece em `completed` e continua na lista `wait`). O job de sonda do prefixo `test` foi removido depois.
  - Nenhum erro `Missing key` ou `ERROR` do worker durante a suíte (conferido com `docker compose logs --since 10m`).
  - Removido o parágrafo "Stop the worker before running the video suites" de `nestjs-project/CLAUDE.md`, como manda o critério de aceite.
  - Ainda não verificado: o `docker compose stop video-worker` esperando um job em voo (pendência da SI-03.7, fora desta tarefa).
