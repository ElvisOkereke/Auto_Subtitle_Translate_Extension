// Creates the Python venv (if needed) and runs fetch_video_fixtures.py.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const venv = path.join(root, 'e2e/.cache/venv');
const py = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });

if (!fs.existsSync(py)) {
  run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', venv]);
}
run(py, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'yt-dlp', 'imageio-ffmpeg', 'pillow', 'numpy']);
run(py, ['-I', path.join(root, 'e2e/scripts/fetch_video_fixtures.py'), ...process.argv.slice(2)]);
