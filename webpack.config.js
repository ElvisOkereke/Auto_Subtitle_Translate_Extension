const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const ORT_DIST = path.resolve(__dirname, 'node_modules/@huggingface/transformers/dist');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  const shared = {
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js'
      // No `clean` here: two compilers write into dist/ in parallel.
      // `npm run build` wipes dist/ first via the prebuild scripts.
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: { loader: 'ts-loader' }
        }
      ]
    },
    optimization: {
      minimize: isProduction,
      // Every entry must be a single self-contained file: nothing declares how
      // to load extra chunks inside an extension page or worker.
      splitChunks: false
    },
    devtool: isProduction ? false : 'source-map',
    resolve: {
      extensions: ['.ts', '.js', '.json']
    },
    performance: { hints: false }
  };

  const pages = {
    ...shared,
    name: 'pages',
    target: 'web',
    entry: {
      background: './src/background.ts',
      content: './src/content.ts',
      popup: './src/popup.ts',
      realTimeTranslate: './src/realTimeTranslate.ts',
      offscreen: './src/offscreen.ts',
      subtitle: './src/subtitle/index.ts',
      ocrFrame: './src/ocr/ocrFrame.ts',
      mseTap: './src/subtitle/readAhead/mseTap.main.ts'
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'popup.html', to: 'popup.html' },
          { from: 'popup.css', to: 'popup.css' },
          { from: 'node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2', to: 'fonts/atkinson-400.woff2' },
          { from: 'node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2', to: 'fonts/atkinson-700.woff2' },
          { from: 'offscreen.html', to: 'offscreen.html' },
          { from: 'ocr-frame.html', to: 'ocr-frame.html' },
          { from: 'src/ocr/charsets/', to: 'ocr/charsets/' },
          { from: 'subtitle-overlay.css', to: 'subtitle-overlay.css' },
          { from: 'icons/', to: 'icons/', noErrorOnMissing: true }
        ]
      })
    ]
  };

  // The Whisper worker is a dedicated Web Worker: no `document`, so it needs
  // the webworker target. ONNX Runtime's wasm + loader are shipped as plain
  // files and loaded from the extension origin (see whisper.worker.ts) because
  // the extension CSP forbids the CDN that transformers.js defaults to.
  const worker = {
    ...shared,
    name: 'worker',
    target: 'webworker',
    entry: {
      'whisper.worker': './src/whisper.worker.ts',
      'ocr.worker': './src/ocr/ocr.worker.ts'
    },
    module: {
      ...shared.module,
      parser: {
        // Don't let webpack rewrite onnxruntime's `new URL(..., import.meta.url)`
        // into hashed assets; we copy the real files below.
        javascript: { url: false }
      }
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: `${ORT_DIST}/ort-wasm-simd-threaded.jsep.mjs`, to: 'ort/[name][ext]' },
          { from: `${ORT_DIST}/ort-wasm-simd-threaded.jsep.wasm`, to: 'ort/[name][ext]' }
        ]
      })
    ]
  };

  return [pages, worker];
};
