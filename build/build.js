/*
 * @description: 生成环境打包
 * @author: peroLuo
 * @date: 2020-06-29 14:58:49
 */

"use strict";
require("./check-versions")();
process.env.NODE_ENV = "production";
const ora = require("ora");
const rm = require("rimraf"); // 删除指定目录的所有文件
const chalk = require("chalk");
const webpack = require("webpack");
const Koa = require("koa");
const koaStatic = require("koa-static");
const compress = require("koa-compress");
const history = require("connect-history-api-fallback");
const path = require("path");
const config = require("../config");
const webpackConfig = require("./webpack.prod.conf");

const spinner = ora("building for production...");
spinner.start();

rm(
  path.join(config.build.assetsRoot, config.build.assetsSubDirectory),
  (err) => {
    if (err) throw err;
    webpack(webpackConfig, (err, stats) => {
      spinner.stop();

      if (err) throw err;

      process.stdout.write(
        stats.toString({
          colors: true,
          modules: false,
          children: true,
          chunks: false,
          chunkModules: false,
        }) + "\n\n"
      );

      if (stats.hasErrors()) {
        console.log(chalk.red("  Build failed with errors.\n"));
        process.exit(1);
      }

      console.log(chalk.green("Webpack build complete.\n"));

      if (!config.build.bundleAnalyzerReport) {
        console.log(chalk.cyan("Running server...\n"));
        runServer();
      } else {
        console.log(chalk.green("webpackBundleAnalyzer is running!\n"));
      }
    });
  }
);

function runServer() {
  const app = new Koa();
  if (config.build.productionGzip) {
    app.use(compress({}));
  }
  app.use(async (ctx, next) => {
    history({
      disableDotRule: true,
      verbose: true,
      logger: () => {},
      htmlAcceptHeaders: ["text/html", "application/xhtml+xml"],
    })(ctx, null, () => {});
    await next();
  });
  app.use(
    koaStatic(config.build.assetsRoot, {
      maxage: config.build.cacheControl,
      gzip: config.build.productionGzip,
      extensions: ["html"],
    })
  );
  app.listen(config.build.port, () => {
    console.log(
      chalk.green(`server is running at http://localhost:${config.build.port}`)
    );
  });
}
