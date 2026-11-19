"""Builds the Chrome Web Store package: release/auto-subtitle-translator-<version>.zip

  npm run package

A production build into release/store/ (dist/, which a browser may have loaded,
is left alone), minus what only the tests need: the page tap's localhost and
127.0.0.1 matches. Fails if the result still mentions a test-only match or
contains source maps.
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'release', 'store')
TEST_ONLY = ('http://127.0.0.1/*', 'http://localhost/*')


def main() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    env = {**os.environ, 'BUILD_OUT': OUT}
    npx = shutil.which('npx') or 'npx'
    subprocess.run([npx, 'webpack', '--mode', 'production'], cwd=ROOT, env=env, check=True)

    path = os.path.join(OUT, 'manifest.json')
    manifest = json.load(open(path, encoding='utf-8'))
    for script in manifest.get('content_scripts', []):
        script['matches'] = [m for m in script['matches'] if m not in TEST_ONLY]
    text = json.dumps(manifest, indent=2)
    if any(m in text for m in TEST_ONLY):
        sys.exit('test-only match left in the manifest')
    open(path, 'w', encoding='utf-8').write(text)

    maps = [f for _, _, files in os.walk(OUT) for f in files if f.endswith('.map')]
    if maps:
        sys.exit(f'source maps in the package: {maps[:3]}')

    zip_path = os.path.join(ROOT, 'release', f"auto-subtitle-translator-{manifest['version']}.zip")
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for folder, _, files in os.walk(OUT):
            for f in files:
                full = os.path.join(folder, f)
                z.write(full, os.path.relpath(full, OUT).replace(os.sep, '/'))
    print(f'{zip_path} ({os.path.getsize(zip_path) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
