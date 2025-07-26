const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
require('dotenv').config({ path: '.env.development' });

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  
  return {
    entry: {
      background: './src/background.ts',
      content: './src/content.ts',
      popup: './src/popup.ts',
      realTimeTranslate: './src/realTimeTranslate.ts'
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
          {
            from: 'manifest.json',
            to: 'manifest.json'
          },
          {
            from: 'popup.html',
            to: 'popup.html'
          },
          {
            from: 'subtitle-overlay.css',
            to: 'subtitle-overlay.css'
          },
          {
            from: 'icons/',
            to: 'icons/',
            noErrorOnMissing: true
          }
        ]
      }),
      new webpack.DefinePlugin({
        'WHISPER_SERVICE_URL': JSON.stringify(process.env.WHISPER_SERVICE_URL)
      })
    ],
    
    optimization: {
      minimize: isProduction,
      splitChunks: {
        chunks: 'all',
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all'
          }
        }
      }
    },
    
    devtool: isProduction ? false : 'source-map',
    
    resolve: {
      extensions: ['.ts', '.js', '.json']
    }
  };
};