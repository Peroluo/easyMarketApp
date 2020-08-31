"use strict";
const path = require("path");
const utils = require("./utils");
const config = require("../config");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
function resolve(dir) {
  return path.join(__dirname, "..", dir);
}

module.exports = {
  // 基础目录，绝对路径，用于从配置中解析入口起点(entry point)和 loader
  context: path.resolve(__dirname, "../"),

  // 入口
  entry: {
    app: "./src/main.js",
  },

  // 输出
  output: {
    path: config.build.assetsRoot, // 输出路径"../dist"
    filename: "[name].js", // 输出文件命名
    // 文件前缀
    publicPath:
      process.env.NODE_ENV === "production"
        ? config.build.assetsPublicPath
        : config.dev.assetsPublicPath,
  },

  // 设置模块被解析
  resolve: {
    extensions: [".js", ".json", ".ts", ".jsx", ".tsx"],
    alias: {
      "@": resolve("src"),
    },
  },

  // 模块（打包规则）
  module: {
    rules: [
      // .global css/less不使用postcss-loader和cssmodules
      {
        test: new RegExp(`^(.*.global).*.(css|less)$`),
        exclude: /node_modules/,
        use: [
          {
            loader: MiniCssExtractPlugin.loader,
          },
          {
            loader: "css-loader",
            options: {
              sourceMap: config.dev.cssSourceMap,
            },
          },
          {
            loader: "less-loader",
          },
          {
            loader: "postcss-loader",
          },
        ],
      },
      {
        test: new RegExp(`^(?!.*.global).*.(css|less)$`),
        exclude: /node_modules/,
        use: [
          {
            loader: MiniCssExtractPlugin.loader,
          },
          {
            loader: "css-loader",
            options: {
              modules: config.dev.cssModules,
              sourceMap: config.dev.cssSourceMap,
            },
          },
          {
            loader: "less-loader",
          },
          {
            loader: "postcss-loader",
          },
        ],
      },
      {
        test: /\.(jsx|tsx|ts|js)?$/,
        use: [
          "babel-loader",
          {
            loader: "eslint-loader",
            options: {
              formatter: require("eslint-friendly-formatter"),
              emitWarning: !config.dev.showlintErrorsInOverlay,
              emitError: !config.dev.showlintErrorsInOverlay,
            },
          },
        ],
        include: [resolve("src")],
        exclude: /node_modules/,
      },
      {
        test: /\.(png|jpe?g|gif|svg)(\?.*)?$/,
        loader: "url-loader",
        options: {
          limit: 10000,
          name: utils.assetsPath("img/[name].[hash:7].[ext]"),
        },
      },
      {
        test: /\.(mp4|webm|ogg|mp3|wav|flac|aac)(\?.*)?$/,
        loader: "url-loader",
        options: {
          limit: 10000,
          name: utils.assetsPath("media/[name].[hash:7].[ext]"),
        },
      },
      {
        test: /\.(woff2?|eot|ttf|otf)(\?.*)?$/,
        loader: "url-loader",
        options: {
          limit: 10000,
          name: utils.assetsPath("fonts/[name].[hash:7].[ext]"),
        },
      },
    ],
  },

  plugins: [],

  // node.js 环境编写的代码，在其他环境（如浏览器）中运行
  node: {
    // empty：空对象、false：什么都不提供
    setImmediate: false,
    dgram: "empty",
    fs: "empty",
    net: "empty",
    tls: "empty",
    child_process: "empty",
  },
};
