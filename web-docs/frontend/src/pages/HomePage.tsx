import { useNavigate } from 'react-router-dom';
import { Button, Row, Col, Card, Tabs, Tag, message } from 'antd';
import {
  BookOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  GithubOutlined,
  PlayCircleOutlined,
  ArrowRightOutlined,
  RobotOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  AimOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import Logo from '../components/Logo';

const features = [
  {
    icon: '⚡',
    title: 'Runtime 调度',
    desc: '不依赖外部 Agent 框架，核心调度、会话持久化、工具执行、上下文转换核心实现，完全可控。',
    color: 'linear-gradient(135deg, #fef3c7, #fde68a)',
  },
  {
    icon: '🔌',
    title: '可插拔扩展机制',
    desc: 'Extension（Tapable 钩子）+ ContextTransformer（按序链式转换）双重扩展，任意注入业务逻辑。',
    color: 'linear-gradient(135deg, #dbeafe, #bfdbfe)',
  },
  {
    icon: '💾',
    title: '会话持久化 + 多会话',
    desc: '内存/文件双存储适配器，JSON 原子写入 + 存储级锁（多进程互斥）。SessionManager 让多会话共享同一 Runtime，历史互相隔离。',
    color: 'linear-gradient(135deg, #dcfce7, #bbf7d0)',
  },
  {
    icon: '🌊',
    title: '流式 + 同步双入口',
    desc: 'run() 一次性返回 + stream() 异步生成器，支持文本增量、思考过程、工具事件，适配任意 UI。',
    color: 'linear-gradient(135deg, #fce7f3, #fbcfe8)',
  },
  {
    icon: '🧩',
    title: '丰富的内置包',
    desc: '持久化记忆、策略管道上下文压缩、CLI、可观测性，按需组合，零配置开箱。',
    color: 'linear-gradient(135deg, #e0e7ff, #c7d2fe)',
  },
  {
    icon: '🛡️',
    title: '权限与沙箱双防线',
    desc: 'PermissionPolicy 统一裁决（deny-by-default + confirm 钩子）+ Tool 能力声明；工具沙箱进程级隔离：fs 白名单、env 白名单、secrets broker、资源限额超限强杀。',
    color: 'linear-gradient(135deg, #fff7ed, #fed7aa)',
  },
];

const quickInstallCode = `# 安装核心框架
pnpm add @aipack-ai/agent

# 或使用 npm
npm install @aipack-ai/agent

# （可选）全局安装命令行工具
pnpm add -g @aipack-ai/cli`;

const minimalExample = `import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from '@aipack-ai/agent';

// 1. 获取内置模型（需配置环境变量：DEEPSEEK_API_KEY）
const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');

// 2. 创建 Runtime
const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  systemPrompt: '你是一个简洁高效的 AI 助手',
  sessionStorage: createFileSessionStorage({ baseDir: './sessions' }),
});

// 3. 同步调用
const result = await runtime.run(
  createRequest('用一句话介绍 aipack')
);
console.log(result.content);

// 4. 流式调用（打字机效果）
for await (const chunk of runtime.stream(
  createRequest('写一首关于春天的诗')
)) {
  if (chunk.type === 'text') process.stdout.write(chunk.content ?? '');
}

await runtime.close();`;

const architectureIntro = `# 数据流
用户请求 (Request)
   ↓
Runtime.beforeRun (Extension 钩子)
   ↓
从 SessionStorage 恢复历史消息
   ↓
转换器链式执行（ContextTransformer）
   ↓   (工具配对、上下文裁剪、记忆注入、压缩等)
模型调用 (streamFn) ←→ Tool Call 循环
   ↓
runLoop：检测 tool_call → 并行执行工具 → 回填结果
   ↓
Runtime.done / failed 钩子
   ↓
持久化会话 → 返回 Result / ResultChunk`;

export default function HomePage() {
  const navigate = useNavigate();

  const copyInstall = async () => {
    await navigator.clipboard.writeText('pnpm add @aipack-ai/agent');
    message.success('安装命令已复制');
  };

  return (
    <div>
      {/* Hero Section */}
      <section className="hero-section">
        <div className="hero-content">
          <h1 className="hero-title">
            用 aipack，<br />快速构建你的 AI Agent
          </h1>
          <p className="hero-subtitle">
            一款轻量、可扩展、零魔法的 TypeScript Agent 框架。<br />
            Runtime + Extension + Transformer 三层架构，核心调度，不依赖外部 Agent 库。
            <br />
            内置持久化记忆、上下文压缩、CLI、可观测性。
          </p>
          <div className="hero-buttons">
            <Button
              type="primary"
              size="large"
              icon={<ThunderboltOutlined />}
              onClick={() => navigate('/quickstart')}
              style={{
                height: 48,
                paddingLeft: 32,
                paddingRight: 32,
                fontSize: 16,
                fontWeight: 600,
                borderRadius: 12,
              }}
            >
              5 分钟快速开始 <ArrowRightOutlined />
            </Button>
            <Button
              size="large"
              icon={<BookOutlined />}
              onClick={() => navigate('/api')}
              style={{
                height: 48,
                paddingLeft: 32,
                paddingRight: 32,
                fontSize: 16,
                fontWeight: 600,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.1)',
                borderColor: 'rgba(255,255,255,0.3)',
                color: 'white',
              }}
            >
              查看 API 文档
            </Button>
            <Button
              size="large"
              icon={<GithubOutlined />}
              onClick={() => window.open('https://github.com/luoguoxiong/aipack', '_blank')}
              style={{
                height: 48,
                paddingLeft: 24,
                paddingRight: 24,
                fontSize: 16,
                fontWeight: 600,
                borderRadius: 12,
              }}
            >
              源码
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="feature-section">
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontSize: '2.25rem', fontWeight: 800, margin: 0, color: '#0f172a' }}>
              为什么选择 aipack
            </h2>
            <p style={{ fontSize: '1.1rem', color: '#64748b', marginTop: 16, lineHeight: 1.8 }}>
              从简单聊天到复杂编码 Agent，用统一的抽象、一致的 API，构建属于你自己的 AI 应用。
            </p>
          </div>
          <Row gutter={[24, 24]}>
            {features.map((f, i) => (
              <Col xs={24} sm={12} md={8} key={i}>
                <div className="feature-card">
                  <div className="feature-icon" style={{ background: f.color }}>
                    {f.icon}
                  </div>
                  <h3 className="feature-title">{f.title}</h3>
                  <p className="feature-desc">{f.desc}</p>
                </div>
              </Col>
            ))}
          </Row>
        </div>
      </section>

      {/* Install + Example */}
      <section style={{ padding: '80px 20px', background: 'white' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <Row gutter={[40, 24]} align="top">
            <Col xs={24} md={10}>
              <h2 className="section-title" style={{ marginTop: 0 }}>
                <ThunderboltOutlined /> 一行安装
              </h2>
              <p className="section-subtitle">
                使用你熟悉的包管理器，10 秒完成安装。
                框架轻量无负担，核心包无多余依赖。
              </p>
              <div className="install-block" onClick={copyInstall} style={{ cursor: 'pointer' }}>
                <div className="install-code">
                  <span className="prompt">$</span>
                  pnpm add @aipack-ai/agent
                </div>
                <Button size="small" type="primary" ghost onClick={(e) => { e.stopPropagation(); copyInstall(); }}>
                  复制
                </Button>
              </div>
              <CodeBlock code={quickInstallCode} language="bash" />
              <Button
                type="primary"
                size="large"
                icon={<PlayCircleOutlined />}
                onClick={() => navigate('/quickstart')}
                style={{ marginTop: 16 }}
              >
                查看详细安装步骤
              </Button>
            </Col>
            <Col xs={24} md={14}>
              <h2 className="section-title" style={{ marginTop: 0 }}>
                <CodeOutlined /> 最小示例
              </h2>
              <p className="section-subtitle">
                导入内置模型、创建 Runtime、发起请求 —— 仅需几行代码，
                即可获得一个带会话持久化的完整 Agent。
              </p>
              <CodeBlock code={minimalExample} language="typescript" />
            </Col>
          </Row>
        </div>
      </section>

      {/* Architecture */}
      <section style={{ padding: '80px 20px', background: '#f9fafb' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <h2 style={{ fontSize: '2.25rem', fontWeight: 800, margin: 0, color: '#0f172a' }}>
              架构概览
            </h2>
            <p style={{ fontSize: '1.1rem', color: '#64748b', marginTop: 16 }}>
              Runtime + Extension + Transformer 三层协作，数据流清晰可见
            </p>
          </div>

          <div className="arch-container">
            <div className="arch-layers">
              {/* 用户层 */}
              <div className="arch-layer">
                <div className="arch-label">入口层</div>
                <div className="arch-boxes">
                  <div className="arch-box arch-box-adapter">
                    <ExperimentOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>CLI</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>aipack / aipack -p</div>
                  </div>
                  <div className="arch-box arch-box-adapter">
                    <RobotOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>编程式 API</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>createRuntime()</div>
                  </div>
                  <div className="arch-box arch-box-adapter">
                    <AppstoreOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>自定义应用</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>任意宿主集成</div>
                  </div>
                </div>
              </div>

              <div className="arch-arrow">▼</div>

              {/* 核心层 */}
              <div className="arch-layer">
                <div className="arch-label">核心调度</div>
                <div className="arch-boxes">
                  <div className="arch-box arch-box-core">
                    <RobotOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>Runtime</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>run() / stream() 循环</div>
                  </div>
                  <div className="arch-box arch-box-core">
                    <AimOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>TaskGraph</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>工具依赖图</div>
                  </div>
                  <div className="arch-box arch-box-core">
                    <CodeOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>Transformers</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>转换器数组（链式执行）</div>
                  </div>
                </div>
              </div>

              <div className="arch-arrow">▼</div>

              {/* 扩展层 */}
              <div className="arch-layer">
                <div className="arch-label">扩展层</div>
                <div className="arch-boxes">
                  <div className="arch-box arch-box-extension">
                    <SettingOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>Extension</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>生命周期钩子（Tapable）</div>
                  </div>
                  <div className="arch-box arch-box-extension">
                    <CodeOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>Transformer</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>上下文链式转换</div>
                  </div>
                  <div className="arch-box arch-box-extension">
                    <SafetyCertificateOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>Tool Hooks</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>before/after 拦截</div>
                  </div>
                </div>
              </div>

              <div className="arch-arrow">▼</div>

              {/* 基础设施层 */}
              <div className="arch-layer">
                <div className="arch-label">基础设施</div>
                <div className="arch-boxes">
                  <div className="arch-box arch-box-storage">
                    <DatabaseOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>SessionStorage</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>文件 / 内存</div>
                  </div>
                  <div className="arch-box arch-box-storage">
                    <AppstoreOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>AI 模型层</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>多提供商流式实现</div>
                  </div>
                  <div className="arch-box arch-box-storage">
                    <ExperimentOutlined style={{ fontSize: 24 }} />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>Tools</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>内置工具 + 自定义</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 包导航 */}
      <section style={{ padding: '80px 20px', background: 'white' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <h2 style={{ fontSize: '2.25rem', fontWeight: 800, margin: 0, color: '#0f172a' }}>
              4 个配套包，按需组合
            </h2>
            <p style={{ fontSize: '1.1rem', color: '#64748b', marginTop: 16 }}>
              从核心框架到完整 CLI，覆盖 Agent 开发的完整场景
            </p>
          </div>

          <Tabs
            className="custom-tabs"
            defaultActiveKey="1"
            items={[
              {
                key: '1',
                label: '核心 & CLI',
                children: (
                  <Row gutter={[24, 24]}>
                    <Col xs={24} md={12}>
                      <Card
                        title={
                          <span>
                            <Logo size={20} radius={4} style={{ verticalAlign: -3, marginRight: 6 }} />
                            aipack <Tag color="blue" style={{ marginLeft: 8 }}>核心</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8 }}>
                          Runtime + Extension + Transformer 三层架构核心。调度、会话、工具、上下文转换。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/packages#aipack')}>
                          查看详情
                        </Button>
                      </Card>
                    </Col>
                    <Col xs={24} md={12}>
                      <Card
                        title={
                          <span>
                            ⌨️ aipack-cli <Tag color="purple" style={{ marginLeft: 8 }}>CLI</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8 }}>
                          交互 REPL、非交互管道、JSON 事件流三种模式；内置文件与 shell 工具，智能权限策略零打断。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/packages#cli')}>
                          查看详情
                        </Button>
                      </Card>
                    </Col>
                  </Row>
                ),
              },
              {
                key: '2',
                label: '能力增强',
                children: (
                  <Row gutter={[24, 24]}>
                    <Col xs={24} md={8}>
                      <Card
                        title={
                          <span>
                            🕸️ multi-agent <Tag color="geekblue" style={{ marginLeft: 8 }}>编排</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8, fontSize: 14 }}>
                          声明式 AgentGraph + 5 种模板（Pipeline/Router/Supervisor/Debate/MapReduce）。Runtime 即 Agent，SharedContext 协作。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/multi-agent')}>
                          查看
                        </Button>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        title={
                          <span>
                            🧠 memory <Tag color="green" style={{ marginLeft: 8 }}>记忆</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8, fontSize: 14 }}>
                          自动捕获/注入。BM25 + 向量双路混合召回。记忆合并与 TTL。4 个记忆工具。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/packages#memory')}>
                          查看
                        </Button>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        title={
                          <span>
                            🗜️ compression <Tag color="orange" style={{ marginLeft: 8 }}>压缩</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8, fontSize: 14 }}>
                          策略管道上下文压缩：统一预算双水位，trim 裁剪 → summarize 摘要 → truncate 保底。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/packages#compression')}>
                          查看
                        </Button>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        title={
                          <span>
                            📡 observability <Tag color="cyan" style={{ marginLeft: 8 }}>观测</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8, fontSize: 14 }}>
                          上报 SDK：appId+appSecret 一行接入，6 类事件自动埋点上报，失败本地缓存补报。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/packages#aipack-observability')}>
                          查看
                        </Button>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        title={
                          <span>
                            🗄️ observability-server <Tag color="cyan" style={{ marginLeft: 8 }}>观测</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8, fontSize: 14 }}>
                          后台收集服务：SQLite 落盘 + 内存聚合 + REST 查询，独立部署、appId+Secret 鉴权。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/packages#aipack-observability-server')}>
                          查看
                        </Button>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        title={
                          <span>
                            🔌 mcp <Tag color="volcano" style={{ marginLeft: 8 }}>MCP</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8, fontSize: 14 }}>
                          双向打通 MCP 生态：连接外部 MCP Server 包装远端工具，或把 aipack 工具反向暴露为 MCP Server。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/mcp')}>
                          查看
                        </Button>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        title={
                          <span>
                            🧪 eval <Tag color="purple" style={{ marginLeft: 8 }}>评测</Tag>
                          </span>
                        }
                        bordered
                      >
                        <p style={{ color: '#475569', lineHeight: 1.8, fontSize: 14 }}>
                          评测闭环：mock replay / live 双模式 + 规则与 LLM 评分器 + baseline 门禁 + 历史趋势。
                        </p>
                        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => navigate('/eval')}>
                          查看
                        </Button>
                      </Card>
                    </Col>
                  </Row>
                ),
              },
            ]}
          />
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ fontSize: 24, marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Logo size={28} />
            aipack
          </div>
          <p style={{ lineHeight: 1.8 }}>
            一款轻量、可扩展、零魔法的 TypeScript Agent 框架。<br />
            MIT License · 文档构建于 React + Ant Design。
          </p>
          <div style={{ marginTop: 16, display: 'flex', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a onClick={() => navigate('/quickstart')} style={{ cursor: 'pointer' }}>快速开始</a>
            <a onClick={() => navigate('/api')} style={{ cursor: 'pointer' }}>API 文档</a>
            <a onClick={() => navigate('/extend')} style={{ cursor: 'pointer' }}>扩展指南</a>
            <a onClick={() => navigate('/examples')} style={{ cursor: 'pointer' }}>示例代码</a>
            <a href="https://github.com/luoguoxiong/aipack" target="_blank" rel="noopener noreferrer" style={{ cursor: 'pointer' }}>GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
