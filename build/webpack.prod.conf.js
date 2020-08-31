/*
 * @Descripttion:
 * @Author: peroLuo
 * @Date: 2020-06-18 15:33:59
 * @LastEditTime: 2020-06-22 21:09:37
 */

"use strict";
const path = require("path");
const utils = require("./utils");
const webpack = require("webpack");
const config = require("../config");
const merge = require("webpack-merge");
const baseWebpackConfig = require("./webpack.base.conf");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const OptimizeCSSPlugin = require("optimize-css-assets-webpack-plugin");
const UglifyJsPlugin = require("uglifyjs-webpack-plugin");
const HardSourceWebpackPlugin = require("hard-source-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const env = require("../config/prod.env");

const webpackConfig = merge(baseWebpackConfig, {
  mode: "production",
  devtool: config.build.productionSourceMap ? config.build.devtool : false,
  output: {
    path: config.build.assetsRoot,
    filename: utils.assetsPath("js/[name].[contenthash].js"),
    chunkFilename: utils.assetsPath("js/[id].[contenthash].js"),
  },
  plugins: [
    new UglifyJsPlugin({
      cache: true,
      parallel: true,
      sourceMap: true,
    }),
    new MiniCssExtractPlugin({
      filename: utils.assetsPath("css/[name].[contenthash].css"),
      chunkFilename: utils.assetsPath("css/[id].[contenthash].css"),
    }),
    // 用来定义全局变量，在webpack打包的时候会对这些变量做替换。
    new webpack.DefinePlugin({
      "process.env": env,
    }),
    new OptimizeCSSPlugin({
      cssProcessorOptions: config.build.productionSourceMap
        ? { safe: true, map: { inline: false } }
        : { safe: true },
    }),
    // html模板配置
    new HtmlWebpackPlugin({
      filename: config.build.index,
      template: "index.html",
      inject: true,
    }),
    // enable scope hoisting
    new webpack.optimize.ModuleConcatenationPlugin(),

    // copy custom static assets
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, "../static"),
          to: config.build.assetsSubDirectory,
          globOptions: {
            ignore: [".*"],
          },
        },
      ],
    }),
  ],
});

if (config.build.usePreload) {
  const PreloadWebpackPlugin = require("preload-webpack-plugin");
  webpackConfig.plugins.push(
    new PreloadWebpackPlugin({
      rel: "preload",
      include: "allChunks",
    })
  );
}

if (config.build.productionGzip) {
  const CompressionWebpackPlugin = require("compression-webpack-plugin");

  webpackConfig.plugins.push(
    new CompressionWebpackPlugin({
      algorithm: "gzip",
    })
  );
}

if (config.build.bundleAnalyzerReport) {
  const BundleAnalyzerPlugin = require("webpack-bundle-analyzer")
    .BundleAnalyzerPlugin;
  webpackConfig.plugins.push(new BundleAnalyzerPlugin());
} else {
  webpackConfig.plugins.push(new HardSourceWebpackPlugin());
}

module.exports = webpackConfig;
