import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoFixtures {
  validVideoPath: string;
  notAVideoPath: string;
  cleanup(): Promise<void>;
}

// A 2-second 320x240 MP4 and a plain text file named like a video, in a temp directory.
export async function createVideoFixtures(): Promise<VideoFixtures> {
  const directory = await mkdtemp(join(tmpdir(), 'streamtube-fixtures-'));
  const validVideoPath = join(directory, 'valid.mp4');
  const notAVideoPath = join(directory, 'not-a-video.mp4');

  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=320x240:rate=25',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    validVideoPath,
  ]);
  await writeFile(notAVideoPath, 'this is plain text, not a video');

  return {
    validVideoPath,
    notAVideoPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
