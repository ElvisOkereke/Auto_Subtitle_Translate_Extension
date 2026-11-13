// The benchmark video set (videos.json) and its reference timelines.
import fs from 'node:fs';
import path from 'node:path';
import type { RefLine } from './metrics';

export interface NormalizedBox { x: number; y: number; w: number; h: number }
export interface BenchVideo {
  id: string;
  mode: 'subtitles' | 'audio';
  lang: string;
  start: number;
  duration: number;
  box?: NormalizedBox;
  reference?: string;
  /** Stretch of the reference file that covers the window (default 'b', the benchmark cut). */
  referenceStretch?: string;
  notes?: string;
}

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'subtitles');

export const benchVideos: BenchVideo[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'videos.json'), 'utf8')).videos;

interface ReferenceFile {
  stretches: { id: string; start: number; end: number; file: string }[];
  lines: { stretch: string; start: number; end: number; ko: string; en?: string; h?: number }[];
}

/** The cut file that covers the window and where it starts in the video (absolute seconds). */
export function referenceStretch(video: BenchVideo): { id: string; start: number; file: string } {
  const ref: ReferenceFile = JSON.parse(fs.readFileSync(path.join(FIXTURES, video.reference!), 'utf8'));
  const id = video.referenceStretch ?? 'b';
  const stretch = ref.stretches.find(s => s.id === id);
  if (!stretch) throw new Error(`${video.reference} has no stretch ${id}`);
  return stretch;
}

/** Reference lines of the video's window, in absolute video seconds. */
export function referenceLines(video: BenchVideo): RefLine[] {
  const ref: ReferenceFile = JSON.parse(fs.readFileSync(path.join(FIXTURES, video.reference!), 'utf8'));
  const stretch = referenceStretch(video);
  return ref.lines
    .filter(l => l.stretch === stretch.id)
    .map(l => ({ start: l.start + stretch.start, end: l.end + stretch.start, ko: l.ko, en: l.en, h: l.h }));
}
