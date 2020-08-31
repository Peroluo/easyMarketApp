/*
 * @Descripttion: 打包相关工具
 * @Author: peroLuo
 * @Date: 2020-06-18 15:50:56
 * @LastEditTime: 2020-06-24 18:05:42
 */
"use strict";
const path = require("path");
const config = require("../config");
const packageConfig = require("../package.json");

// 工作区间路径
exports.wordDir = path.join(__dirname, "..", "src");

// 静态文件路径
exports.assetsPath = function (_path) {
  const assetsSubDirectory =
    process.env.NODE_ENV === "production"
      ? config.build.assetsSubDirectory
      : config.dev.assetsSubDirectory;
  return path.posix.join(assetsSubDirectory, _path);
};

// 客户端消息提醒
exports.createNotifierCallback = () => {
  const notifier = require("node-notifier");

  return (severity, errors) => {
    if (severity !== "error") return;

    const error = errors[0];
    const filename = error.file && error.file.split("!").pop();

    notifier.notify({
      title: packageConfig.name,
      message: severity + ": " + error.name,
      subtitle: filename || "",
      icon: path.join(__dirname, "logo.png"),
    });
  };
};
