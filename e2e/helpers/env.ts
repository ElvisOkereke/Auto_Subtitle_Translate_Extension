import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths';

/** Reads a variable from the environment, falling back to the gitignored .env file. */
export function readEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && match[1] === name) return match[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}
