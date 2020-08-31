/*
 * @Descripttion: 开发环境和生成环境的配置
 * @Author: peroLuo
 * @Date: 2020-06-18 15:46:42
 * @LastEditTime: 2020-06-24 18:07:04
 */

const path = require("path");

module.exports = {
  dev: {
    assetsSubDirectory: "static", // 静态文件夹
    assetsPublicPath: "/", // 静态文件前缀
    proxyTable: {}, // 代理

    // dev-server配置
    host: "localhost",
    port: 8080,
    autoOpenBrowser: true,
    errorOverlay: true,
    notifyOnErrors: true,
    poll: false, // https://webpack.js.org/configuration/dev-server/#devserver-watchoptions-

    // eslint配置
    useLint: true, // 是否使用eslint
    showlintErrorsInOverlay: true, // 错误跟警告是否显示在浏览器上

    devtool: "eval", //https://webpack.js.org/configuration/devtool/#root

    cssSourceMap: true,

    cssModules: true,
  },

  build: {
    // Template for index.html
    index: path.resolve(__dirname, "../dist/index.html"),

    assetsRoot: path.resolve(__dirname, "../dist"), // 静态文件目录
    assetsSubDirectory: "static", // 静态文件名
    assetsPublicPath: "/",

    // 是否开启资源预加载
    usePreload: false,

    productionSourceMap: true,

    devtool: "#source-map",

    // 是否使用GZIP
    // npm install --save-dev compression-webpack-plugin
    productionGzip: true,

    // `npm run build --report`
    // Set to `true` or `false` to always turn it on or off
    bundleAnalyzerReport: process.env.npm_config_report,

    // 生成环境端口
    port: 8000,

    // 静态资源缓存时间
    cacheControl: 24 * 60 * 60 * 1000 * 90,
  },
};
