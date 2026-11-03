import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  FFMPEG_COMMAND,
  FFPROBE_COMMAND,
  PROBE_TIMEOUT_MS,
  THUMBNAIL_TIMEOUT_MS,
} from './media.constants';

export type MediaMetadata = {
  formatName: string | null;
  bitRate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  frameRate: number | null;
};

export type ProbeResult = {
  durationSeconds: number;
  metadata: MediaMetadata;
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  format?: { format_name?: string; bit_rate?: string; duration?: string };
  streams?: FfprobeStream[];
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(`${command} exited with code ${code}: ${message}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

function toNumberOrNull(value: string | number | undefined): number | null {
  const parsed = Number(value);
  return value === undefined || !Number.isFinite(parsed) ? null : parsed;
}

// ffprobe reports frame rate as a fraction, e.g. "25/1" or "30000/1001".
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!denominator || !Number.isFinite(numerator / denominator)) return null;
  return numerator / denominator;
}

export function parseProbeOutput(raw: string): ProbeResult {
  const output = JSON.parse(raw) as FfprobeOutput;
  const durationSeconds = Number(output.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('ffprobe reported no usable duration');
  }
  const video = output.streams?.find((s) => s.codec_type === 'video');
  const audio = output.streams?.find((s) => s.codec_type === 'audio');

  return {
    durationSeconds,
    metadata: {
      formatName: output.format?.format_name ?? null,
      bitRate: toNumberOrNull(output.format?.bit_rate),
      width: video?.width ?? null,
      height: video?.height ?? null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      frameRate: parseFrameRate(video?.avg_frame_rate),
    },
  };
}

@Injectable()
export class MediaProbeService {
  async probe(url: string): Promise<ProbeResult> {
    const output = await runCommand(
      FFPROBE_COMMAND,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      PROBE_TIMEOUT_MS,
    );
    return parseProbeOutput(output.toString('utf8'));
  }

  async extractThumbnail(url: string, atSeconds: number): Promise<Buffer> {
    return runCommand(
      FFMPEG_COMMAND,
      [
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      THUMBNAIL_TIMEOUT_MS,
    );
  }
}
