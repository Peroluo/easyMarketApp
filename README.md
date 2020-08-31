# react-cli-template

> 1. react-cli-template 基于 Webpack4+搭建的 React 脚手架。
> 2. 支持 TypeScript 与 JavaScript 共存，解决项目向 TS 靠拢问题。
> 3. Css 预处理已配置 Less，可根据自己需求，配置 Sass、Styuls。
> 4. 数据管理已配置 Redux 与 Rematch、路由使用 React-router-dom。

## Quick Start

```shell
git clone https://github.com/Peroluo/react-cli-template.git
cd react-cli-template
cnpm install
```

### npm run dev

> 开发模式运行程序
>
> 自动打开浏览器 [http://localhost:8080](http://localhost:8080)
>
> 开发环境支持热更新，在构建过程中会提醒错误跟警告。

### npm run build

> 生成环境打包
>
> 已配置 GZIP、资源压缩、缓存等构建最佳性能，请参考 webpack 相关配置。
>
> 构建完成后，将启动静态资源服务，打开浏览器 [http://localhost:8000](http://localhost:8000)

### npm run build --report

> 分析打包后的资源大小
>
> 自动打开浏览器 [http://localhost:8888](http://localhost:8888)

### 目录说明

```
react-cli-template
├── static                                          静态文件
├── .babelrc                                        babel配置
├── jsconfig.json                                   vscode相关配置
├── postcss.config.js                               postcss配置
├── tsconfig.json                                   typescript配置
├── typings.d.ts                                    typings
├── index.html                                      html模板
├── .eslintrc.js                                    eslint、tslint配置
├── build                                           构建相关
│   ├── build.js                                    production启动
│   ├── check-versions.js                           npm node版本检测
│   ├── logo.png                                    提示框logo
│   ├── utils.js                                    构建工具
│   ├── webpack.base.conf.js                        webpack公共配置
│   ├── webpack.dev.conf.js                         webpack开发配置
│   └── webpack.prod.conf.js                        webpack生成配置
├── config                                          构建配置
│   ├── dev.env.js                                  开发配置
│   ├── index.js                                    配置入口
│   └── prod.env.js                                 生成配置
└── src                                             项目入口
    └── main.js                                     项目入口文件
```

### 配置文件说明 `config/index.js`

```js
{
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
}
```

