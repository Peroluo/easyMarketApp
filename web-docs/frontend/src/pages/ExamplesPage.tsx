import { Alert, Divider } from 'antd';
import {
  CodeOutlined,
  DatabaseOutlined,
  AimOutlined,
  SettingOutlined,
  RocketOutlined,
  DeploymentUnitOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  exMinimalCode,
  exMemoryCode,
  exCompressionCode,
  exCliConfigCode,
  exMcpClientCode,
  exMcpServerCode,
} from '../data/examplesCode';

export default function ExamplesPage() {
  return (
    <div>
      <h1 className="section-title">
        <CodeOutlined style={{ color: '#6366f1' }} /> 示例代码
      </h1>
      <p className="section-subtitle">
        精选最常用的场景示例：最小应用、记忆集成、上下文压缩、CLI 配置文件、MCP 双向接入。
        直接复制即可运行（仅需配置 <code>{'<PROVIDER>_API_KEY'}</code> 环境变量）。
      </p>

      <Alert
        type="info"
        showIcon
        message="安装示例依赖"
        description={
          <span>
            除 <code>@aipack-ai/agent</code> 核心外：
            memory 示例需 <code>pnpm add @aipack-ai/memory</code>，
            compression 示例需 <code>pnpm add @aipack-ai/compression</code>，
            MCP 示例需 <code>pnpm add @aipack-ai/mcp</code>，
            CLI 需 <code>pnpm add -g @aipack-ai/cli</code>。
          </span>
        }
        style={{ marginBottom: 32 }}
      />

      {/* 1. 最小应用 */}
      <div id="minimal" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 最小可用应用
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          推荐的项目脚手架结构：把 runtime 封装到模块中，其他业务模块直接 import 使用。
          配置同步 + 流式两种调用入口，进程退出前优雅关闭。
        </p>
        <CodeBlock code={exMinimalCode} />
      </div>

      <Divider />

      {/* 2. 记忆集成 */}
      <div id="memory" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DatabaseOutlined /> 长期记忆（跨会话记住用户）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          aipack-memory 提供完整的"记住用户"闭环：<b>捕获 → 索引 → 注入 → 合并</b>。
          默认 BM25 关键词检索（零依赖，支持中文）；配上 Embedder 自动升级为 BM25 + 向量双路召回。
        </p>
        <CodeBlock code={exMemoryCode} />
      </div>

      <Divider />

      {/* 3. 上下文压缩 */}
      <div id="compression" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <AimOutlined /> 策略管道上下文压缩（长对话防炸 Token）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          在长对话 / 大工具输出的场景下，Token 很容易超出模型窗口。
          compression 包提供统一预算下的策略管道（trim → summarize → truncate），对调用方透明。
          动态 import 方式确保不使用时不会被打包。
        </p>
        <CodeBlock code={exCompressionCode} />
      </div>

      <Divider />

      {/* 4. CLI 配置 */}
      <div id="cli" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SettingOutlined /> aipack.config.js（CLI 配置）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          用 aipack-cli 而非写代码时，默认权限策略已开箱即用：读写文件静默放行，bash
          仅危险命令（sudo、rm -rf ~、磁盘写入等）弹出<b>方向键选择器</b>确认（允许 /
          总是允许 / 拒绝）。通过 <code>aipack.config.js</code> 可自定义权限规则、定义子 agent（task）、
          配置 Hooks 与压缩，或开启 <code>approvals.enabled</code> 将危险操作挂起为异步审批单（落盘持久化，
          支持跨终端 <code>aipack approvals</code> 结算）。完整能力见{' '}
          <a href="/cli">CLI 工具页</a>。
        </p>
        <CodeBlock code={exCliConfigCode} />
      </div>

      <Divider />

      {/* 5. MCP 客户端 */}
      <div id="mcp" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DeploymentUnitOutlined /> 连接外部 MCP Server（客户端方向）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>createMcpPlugin</code> 连接外部 MCP Server，把远端工具包装为原生 <code>Tool</code>。
          工具在 <code>beforeRun</code> 阶段懒连接注册，一经包装即获得 runtime 全套能力
          （权限审批 / 超时 / 钩子 / telemetry / 并行调用），模型调用与本地工具完全一致。
        </p>
        <CodeBlock code={exMcpClientCode} />
      </div>

      <Divider />

      {/* 6. MCP 服务端 */}
      <div id="mcp-server" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DeploymentUnitOutlined /> 把 aipack 工具暴露为 MCP Server（服务端方向）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>createMcpServerHost</code> + <code>runStdioServer</code> 把 aipack 原生
          <code> Tool[]</code>（+ 可选 resources / prompts）反向暴露为标准 MCP Server，
          供 Claude Desktop、Cursor 等外部 MCP 客户端经 stdio 调用。零运行时依赖。
        </p>
        <CodeBlock code={exMcpServerCode} />
      </div>
    </div>
  );
}
