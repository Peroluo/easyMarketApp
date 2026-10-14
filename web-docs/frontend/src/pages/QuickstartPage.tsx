import { Alert, Steps, Divider, Result as AntResult } from 'antd';
import {
  ThunderboltOutlined,
  RocketOutlined,
  DatabaseOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  qsInstallCode,
  qsCliQuickstartCode,
  qsEnvCode,
  qsFirstAppCode,
  qsRunCode,
  qsStreamingCode,
  qsMultiTurnCode,
  qsToolCode,
} from '../data/quickstartCode';

export default function QuickstartPage() {
  return (
    <div>
      <h1 className="section-title">
        <ThunderboltOutlined style={{ color: '#6366f1' }} /> 快速开始
      </h1>
      <p className="section-subtitle">
        跟随以下 4 步，5 分钟内跑通你的第一个 aipack 应用，并解锁流式、多轮、工具调用能力。
      </p>

      <Steps
        direction="vertical"
        size="default"
        current={-1}
        items={[
          {
            status: 'process',
            title: '步骤 1：安装依赖',
            description: '支持 pnpm / npm / yarn，推荐使用 pnpm workspace 以获得最佳开发体验。',
          },
          {
            status: 'process',
            title: '步骤 2：配置 API Key',
            description: '通过环境变量或 .env 文件配置模型提供商凭据。',
          },
          {
            status: 'process',
            title: '步骤 3：创建第一个应用',
            description: '使用内置模型 + createRuntime，发起同步请求，得到回答。',
          },
          {
            status: 'process',
            title: '步骤 4+：解锁进阶能力',
            description: '流式响应、多轮对话持久化、自定义工具调用。',
          },
        ]}
        style={{ marginBottom: 40 }}
      />

      <Divider />

      {/* Step 1 */}
      <div id="install" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 步骤 1：安装
        </h2>
        <Alert
          type="info"
          showIcon
          message="Node.js >= 18"
          description="aipack 使用 ES Module + 最新 TypeScript 特性，请确保 Node.js 版本 >= 18。"
          style={{ marginBottom: 16 }}
        />
        <CodeBlock code={qsInstallCode} language="bash" />
      </div>

      {/* Step 2 */}
      <div style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SafetyCertificateOutlined /> 步骤 2：配置 API Key
        </h2>
        <Alert
          type="warning"
          showIcon
          message="不要把 Key 提交到 Git"
          description="API Key 属于敏感凭据，务必放入 .env 或环境变量，并将 .env 加入 .gitignore。"
          style={{ marginBottom: 16 }}
        />
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          aipack 约定提供商 API Key 环境变量格式为：<code>{'<PROVIDER_ID_UPPERCASE>_API_KEY'}</code>。
          支持 DeepSeek、OpenAI、Anthropic、Google、Mistral、Bedrock 等主流提供商。
        </p>
        <CodeBlock code={qsEnvCode} language="bash" />
      </div>

      {/* Step 3 */}
      <div id="first-app" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 步骤 3：创建第一个应用
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          创建 <code>index.ts</code>，粘贴以下代码。<code>getBuiltinModel</code> 会根据
          provider id 自动分派到对应的流式实现（无需手写 streamFn）。
        </p>
        <CodeBlock code={qsFirstAppCode} language="typescript" />
        <p style={{ lineHeight: 1.8, color: '#475569', marginTop: 16 }}>运行：</p>
        <CodeBlock code={qsRunCode} language="bash" />
        <AntResult
          status="success"
          title="如果一切顺利"
          subTitle="你应该能看到类似：🤖 助手: 你好，我是基于 aipack 的 AI 助手…"
          style={{ padding: '24px 0', background: 'white', borderRadius: 12, border: '1px solid #e5e7eb' }}
        />
      </div>

      {/* Step 4-A */}
      <div id="streaming" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 进阶 A：流式响应（打字机效果）
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>runtime.stream()</code> 返回异步生成器，逐块 yield 各种事件。
          推荐在 UI 场景中使用，以获得最佳用户体验。
        </p>
        <CodeBlock code={qsStreamingCode} language="typescript" />
      </div>

      {/* Step 4-B */}
      <div id="multi-turn" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DatabaseOutlined /> 进阶 B：多轮对话 + 持久化
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          同一 <code>Runtime</code> 的多次 <code>run</code> 会自动恢复历史消息。
          <code>sessionKey</code> 在 <code>createRequest</code> 时指定（默认 <code>'default'</code>）。
          配合 <code>createFileSessionStorage</code>，即便重启进程也能继续对话。同一 Runtime 可服务多个会话：请求带不同 sessionKey 即路由到独立会话。
        </p>
        <Alert
          type="info"
          showIcon
          message="maxAge 的单位是毫秒"
          description="例如 30 天 = 30 * 24 * 60 * 60 * 1000。过期会话在下次 load 时被惰性清理。"
          style={{ marginBottom: 16 }}
        />
        <CodeBlock code={qsMultiTurnCode} language="typescript" />
      </div>

      {/* Step 4-C */}
      <div id="tools" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 进阶 C：自定义工具调用
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          aipack 的一大核心能力就是 <b>工具循环</b>：模型输出 tool_call → Runtime 自动执行工具
          → 结果回填上下文 → 继续下一轮推理，直到模型给出最终回答。
          用 <code>TypeBox</code>（随 aipack/ai 导出）声明参数 Schema：
        </p>
        <CodeBlock code={qsToolCode} language="typescript" />
      </div>

      <Divider />

      {/* 零代码路线：CLI */}
      <div id="cli" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ToolOutlined /> 零代码路线：CLI 命令行工具
        </h2>
        <p style={{ lineHeight: 1.8, color: '#475569' }}>
          不想写代码？直接安装 <code>@aipack-ai/cli</code>，在终端获得一个带内置工具的 AI 编程助手：
          交互 REPL、管道单次提问、JSON 事件流三种模式，内置 find / grep / ls / task（子 agent）
          等工具，支持项目记忆文件（AIPACK.md）、Skills、MCP、Hooks 与策略管道上下文压缩。
        </p>
        <CodeBlock code={qsCliQuickstartCode} language="bash" />
        <p style={{ lineHeight: 1.8, color: '#475569', marginTop: 16 }}>
          完整文档见 <a href="/cli">CLI 工具页</a>。
        </p>
      </div>

      <Divider />
      <div style={{ padding: '24px', background: 'linear-gradient(135deg, #eef2ff, #e0e7ff)', borderRadius: 12 }}>
        <h3 style={{ marginTop: 0, color: '#3730a3' }}>🎉 你已掌握基础！</h3>
        <p style={{ lineHeight: 1.8, color: '#4338ca' }}>
          继续探索：
          <a href="/extend"> 扩展指南（自定义 Extension/Transformer）</a> ·
          <a href="/api"> 完整 API 文档</a> ·
          <a href="/examples"> 更多示例代码（记忆、压缩）</a>
        </p>
      </div>
    </div>
  );
}
