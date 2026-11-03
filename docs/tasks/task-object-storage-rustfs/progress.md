# task-object-storage-rustfs — Progress

**Status:** completed
**SIs:** 3/3 completed

### SI-1 — Infra: variáveis de ambiente S3
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - `nestjs-project/.env.example`: `MAIL_FROM` já existente não está entre aspas, o que contraria a convenção de `.env` do CLAUDE.md (caracteres `<`/`>`). Fora do escopo desta SI; registrar como follow-up.
  - `S3_CORS_ALLOWED_ORIGINS=http://localhost:3001` é um valor de exemplo; a porta real do `next-frontend` ainda não foi confirmada.
  - `nestjs-project/.env` (cópia local) não foi alterado, conforme a action 3 da SI.

### SI-2 — Infra: servidor RustFS no Compose
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - Implementado em `nestjs-project/compose.yaml`: serviço `rustfs` com `rustfs/rustfs:1.0.4`, portas 9000/9001, credenciais via `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` (nomes confirmados na documentação do RustFS), volume `rustfs-data` e healthcheck.
  - Aceite verificado no WSL (Docker 29.8.2, Compose v5.5.1), com o compose copiado para `~/rustfs-check` e credenciais via variável de ambiente: `docker compose ps` mostra `rustfs` com `Up (healthy)`; `curl` existe dentro da imagem (healthcheck válido); `localhost:9000` responde HTTP 403 na raiz (servidor S3 sem credenciais) e `/health` responde HTTP 200.
  - O `rustfs` lê `${S3_ACCESS_KEY}`/`${S3_SECRET_KEY}` do `.env` local do compose, que ainda precisa ser atualizado por cada desenvolvedor (SI-1, action 3).

### SI-3 — Infra: init do bucket e do CORS com amazon/aws-cli
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:**
  - Implementado em `nestjs-project/compose.yaml`: serviço `rustfs-init` com `amazon/aws-cli:2.15.0` (tag verificada por pull), `restart: "no"`, `depends_on: rustfs (service_healthy)`, e `nestjs-api` passa a depender de `rustfs-init` com `service_completed_successfully`.
  - Verificado no WSL: `rustfs-init` sai com código 0 na primeira execução; `get-bucket-cors` retorna `PUT`/`GET`/`HEAD`, `ExposeHeaders: ETag` e a origem de dev; uma segunda execução (`--force-recreate`) também sai com código 0, sem erro de bucket existente (idempotente). `docker compose config` valida o arquivo.
  - Desvio do texto da SI: foi incluído `AllowedHeaders: ["*"]`, que a SI não listava. Sem ele, o preflight do navegador para PUT com `Content-Type` falha. Confirmar se é aceitável.
  - Verificação final (Deliverables), rodada numa cópia descartável do `nestjs-project` em `~/rustfs-verify` no WSL, com a stack completa subindo via compose: `npm run build` exit 0; `npx tsc --noEmit` exit 0; `npm test -- --runInBand` exit 0 com 23/23 suites e 144/144 testes.
  - Houve uma execução anterior com 1 suite falhando (`database/migrations.integration-spec.ts`, deadlock e tabela `users` já existente) no primeiro run em banco novo. Não se repetiu: a suíte isolada e a suíte completa passaram depois. Não está ligada às mudanças desta task (só compose e env foram alterados, sem código TypeScript).
  - A cópia de verificação recebeu o bloco `S3_*` no `.env` (só na cópia); o `.env` local do repositório não foi alterado.
