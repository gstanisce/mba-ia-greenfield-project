import { AppModule } from '../app.module';
import { VideoProcessingProcessor } from '../video-processing/video-processing.processor';
import { VideosModule } from '../videos/videos.module';
import { WorkerModule } from './worker.module';

// Metadata-only checks: no module is instantiated, so no database or Redis is touched.
describe('WorkerModule boundary', () => {
  it('should not be imported by the API module graph', () => {
    const apiImports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(apiImports).not.toContain(WorkerModule);
  });

  it('should not provide the processor from the videos module', () => {
    const videosProviders = Reflect.getMetadata(
      'providers',
      VideosModule,
    ) as unknown[];

    expect(videosProviders).not.toContain(VideoProcessingProcessor);
  });
});
