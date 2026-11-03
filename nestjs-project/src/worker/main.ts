import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // On SIGTERM the BullMQ worker is closed only after in-flight jobs finish.
  app.enableShutdownHooks();
}
void bootstrap();
