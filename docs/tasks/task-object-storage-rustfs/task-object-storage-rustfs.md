---
kind: task
name: task-object-storage-rustfs
test_specs_aware: true
sources_mtime:
  docs/tasks/task-object-storage-rustfs/context.md: "2026-11-03T07:48:33.943532800+01:00"
  docs/decisions/technical-decisions-object-storage-rustfs.md: "2026-11-02T17:13:50.719020600+01:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-10-30T11:01:04.328010300+01:00"
  docs/phases/phase-02-auth/context.md: "2026-10-30T11:01:04.362044900+01:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-30T11:01:04.352532900+01:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-30T11:01:04.164344100+01:00"
---

# Task — Substituição do Object Storage Local (RustFS)

## Objective

Substituição do servidor S3 local da Fase 03 (imagem do MinIO indisponível). Supersede de phase-03-videos/TD-02: mantém o AWS SDK v3, troca o servidor compatível com S3 e o serviço de init que cria bucket e CORS.

---

## Step Implementations

### SI-1 — Infra: variáveis de ambiente S3

**Description:** Declarar as variáveis `S3_*` que o servidor, o init e o cliente da Fase 03 vão consumir, sem tocar código de aplicação.

**Technical actions:**

1. Adicionar ao `nestjs-project/.env.example` o bloco `# Object storage (RustFS, S3-compatible)` com `S3_ENDPOINT=http://rustfs:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET=streamtube` e `S3_CORS_ALLOWED_ORIGINS` (per `task-object-storage-rustfs/TD-01`).
2. Definir `S3_CORS_ALLOWED_ORIGINS` com a origem do `next-frontend` em dev (porta real a confirmar no `next-frontend`; o valor de exemplo é `http://localhost:3001`).
3. Não editar `nestjs-project/.env` (cópia local, fora do versionamento); cada desenvolvedor atualiza a própria cópia a partir do `.env.example`.

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `nestjs-project/.env.example` contém as sete chaves `S3_*` listadas na action 1, todas com valor de exemplo preenchido.
- O `.env.example` não introduz nenhuma chave `DB_*`, `MAIL_*` ou `JWT_*` alterada.

---

### SI-2 — Infra: servidor RustFS no Compose

**Description:** Substituir o MinIO pelo servidor RustFS 1.0.4 como serviço S3 local de desenvolvimento, sem alterar código de aplicação.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `rustfs` com `image: rustfs/rustfs:1.0.4` (tag fixa, nunca `latest`), portas `9000:9000` (API S3) e `9001:9001` (console), e volume nomeado para os dados (per `task-object-storage-rustfs/TD-01`).
2. Passar as credenciais de `S3_ACCESS_KEY` e `S3_SECRET_KEY` ao contêiner pelas variáveis de ambiente que a imagem 1.0.4 espera; confirmar os nomes na documentação da imagem antes de implementar.
3. Definir `healthcheck` do `rustfs` com uma ferramenta presente na imagem 1.0.4; confirmar antes de implementar se a imagem inclui `curl` ou `wget`.
4. Declarar o volume nomeado no bloco `volumes:` do compose.

**Tests:** _(empty — Infra)_

**Dependencies:** SI-1

**Acceptance criteria:**

- `docker compose up -d rustfs` deixa o serviço `rustfs` com status `healthy` em `docker compose ps`.
- Uma requisição HTTP a `http://localhost:9000` recebe resposta de servidor S3 (qualquer status HTTP, sem falha de conexão).

---

### SI-3 — Infra: init do bucket e do CORS com amazon/aws-cli

**Description:** Criar um serviço de inicialização de uso único que cria o bucket privado e aplica a configuração de CORS no RustFS, de forma idempotente.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `rustfs-init` com `image: amazon/aws-cli` (tag fixa), `restart: "no"`, e `depends_on: rustfs` com `condition: service_healthy`.
2. Passar `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY` a partir de `S3_ACCESS_KEY` e `S3_SECRET_KEY`, e `AWS_DEFAULT_REGION` a partir de `S3_REGION`.
3. Comando do init: `aws --endpoint-url http://rustfs:9000 s3api create-bucket --bucket $S3_BUCKET`, tolerando `BucketAlreadyOwnedByYou` para manter a execução idempotente.
4. Comando do init: `aws --endpoint-url http://rustfs:9000 s3api put-bucket-cors --bucket $S3_BUCKET` com `AllowedMethods` `PUT`, `GET`, `HEAD`, `AllowedOrigins` vindo de `S3_CORS_ALLOWED_ORIGINS` e `ExposeHeaders` contendo `ETag` (per `phase-03-videos/TD-03` e `task-object-storage-rustfs/TD-01`).
5. Adicionar `rustfs-init` ao `depends_on` do `nestjs-api` com `condition: service_completed_successfully`.

**Tests:** _(empty — Infra)_

**Dependencies:** SI-2

**Acceptance criteria:**

- `docker compose up rustfs-init` termina com código de saída 0, e `docker compose ps -a` mostra `rustfs-init` com status `exited (0)`.
- `aws s3api get-bucket-cors --bucket $S3_BUCKET --endpoint-url http://localhost:9000` retorna uma regra com `ExposeHeaders` contendo `ETag` e os métodos `PUT`, `GET` e `HEAD`.
- Executar `rustfs-init` uma segunda vez termina com código 0, sem erro de bucket já existente.

---

<!-- phase-a-complete -->

## Dependency Map

SI-1 (root)
└── SI-2 — depends on SI-1 (o servidor lê as credenciais `S3_*` definidas no `.env.example`)
    └── SI-3 — depends on SI-2 (o init precisa do `rustfs` healthy)

---

## Deliverables

- [ ] SI-1 — Infra: variáveis de ambiente S3
- [ ] SI-2 — Infra: servidor RustFS no Compose
- [ ] SI-3 — Infra: init do bucket e do CORS com amazon/aws-cli

**Full test suites:**

- [ ] Testes unitários passam (`docker compose exec nestjs-api npm test`)
- [ ] Build compila (`docker compose exec nestjs-api npm run build`)
- [ ] Spec de integração do `StorageService` da fase 03 passa contra o RustFS 1.0.4 (valida `ListParts`, CORS e range reads; depende da implementação da fase 03, não deste plano)
