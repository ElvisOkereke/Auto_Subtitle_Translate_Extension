const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    entry: {
      background: './src/background.ts',
      content: './src/content.ts',
      popup: './src/popup.ts',
      realTimeTranslate: './src/realTimeTranslate.ts',
      offscreen: './src/offscreen.ts',
      'whisper.worker': './src/whisper.worker.ts'
    },

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true
    },

    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader'
          }
        }
      ]
    },

    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'popup.html', to: 'popup.html' },
          { from: 'offscreen.html', to: 'offscreen.html' },
          { from: 'subtitle-overlay.css', to: 'subtitle-overlay.css' },
          { from: 'icons/', to: 'icons/', noErrorOnMissing: true }
        ]
      })
    ],

    optimization: {
      minimize: isProduction,
      // Every entry (including whisper.worker, loaded via `new Worker(url)`)
      // must be a single self-contained file. Chunk-splitting would extract
      // shared node_modules code into a vendors.js that nothing declares
      // how to load.
      splitChunks: false
    },

    devtool: isProduction ? false : 'source-map',

    resolve: {
      extensions: ['.ts', '.js', '.json']
    }
  };
};
