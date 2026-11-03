import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1793708525120 implements MigrationInterface {
  name = 'CreateVideos1793708525120';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('uploading', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_publication_status_enum" AS ENUM('draft')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "original_file_name" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "size_bytes" bigint NOT NULL, "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'uploading', "publication_status" "public"."videos_publication_status_enum" NOT NULL DEFAULT 'draft', "storage_key" character varying(255) NOT NULL, "upload_id" character varying(255), "thumbnail_key" character varying(255), "duration_seconds" numeric(10,3), "metadata" jsonb, "processing_error" text, "processed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_5dbcc1ee100f853490582eccc7" ON "videos" ("slug") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5dbcc1ee100f853490582eccc7"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_publication_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
  }
}
