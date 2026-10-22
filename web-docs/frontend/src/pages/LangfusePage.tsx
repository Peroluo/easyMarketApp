import { useEffect } from 'react';
import { Alert, Card, Row, Col, Tag, Typography, Divider } from 'antd';
import { useLocation } from 'react-router-dom';
import {
  LineChartOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  NodeIndexOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  CloudServerOutlined,
  ApiOutlined,
  DatabaseOutlined,
  CheckCircleOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  lfQuickstartCode,
  lfSetupCode,
  lfPriorityCode,
  lfMappingCode,
  lfRobustCode,
  lfCustomTransportCode,
  lfDeployCode,
  lfOptionsCode,
} from '../data/langfuseCode';

const { Title, Paragraph } = Typography;

const featureList = [
  { icon: <ThunderboltOutlined />, title: 'Extension 一行接入', desc: 'new LangfuseExtension() 注入 extensions 即生效，不改造业务代码' },
  { icon: <NodeIndexOutlined />, title: '全链路 Trace', desc: 'run → Trace、模型调用 → Generation、工具调用 → TOOL observation' },
  { icon: <DatabaseOutlined />, title: '会话聚合', desc: 'sessionKey 自动映射 Langfuse Sessions，按会话维度聚合查看' },
  { icon: <SafetyCertificateOutlined />, title: '失败不阻断', desc: '上报吞错 + 限频告警，inputs 序列化快照防内存滞留' },
  { icon: <CodeOutlined />, title: 'Transport 可注入', desc: 'TraceTransport 抽象，测试离线 fake / 私有部署后端随意替换' },
  { icon: <CloudServerOutlined />, title: '自托管一键部署', desc: 'deploy/langfuse 官方 v4 compose，6 容器本地跑通' },
];

export default function LangfusePage() {
  const location = useLocation();

  // hash 变化 → 自动滚动到对应锚点（初始加载、侧边栏跳转、浏览器前进后退都覆盖）
  useEffect(() => {
    const id = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (!id) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const tryScroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      }
      return false;
    };
    if (!tryScroll()) {
      setTimeout(tryScroll, 50);
    }
  }, [location.hash]);

  return (
    <div>
      <h1 className="section-title">
        <LineChartOutlined style={{ color: '#6366f1' }} /> Langfuse 接入
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/agent-langfuse</b> 以 Extension 形式接入 Langfuse（开源 LLM 可观测平台）：
        apply 阶段经 RuntimeTelemetry 访问器包装底层 Telemetry（emitter 实例不变，对 Runtime 其余模块透明），
        将 run / 模型调用 / 工具调用上报为 Langfuse Trace / Generation / TOOL observation。
      </p>

      {/* 总览 */}
      <div id="overview" style={{ scrollMarginTop: 100 }}>
        <Row gutter={[16, 16]}>
          {featureList.map((f, i) => (
            <Col xs={24} sm={12} md={8} key={i}>
              <Card size="small" className="feature-card" style={{ height: '100%' }}>
                <div style={{ color: '#6366f1', fontSize: 22, marginBottom: 8 }}>{f.icon}</div>
                <div style={{ fontWeight: 700, marginBottom: 4, color: '#0f172a' }}>{f.title}</div>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: '#64748b' }}>{f.desc}</div>
              </Card>
            </Col>
          ))}
        </Row>
        <Alert
          type="success"
          showIcon
          message="静默降级，离线可用"
          description="未提供 transport 且无凭据（显式或 LANGFUSE_* 环境变量）时扩展自动 no-op——代码零改动，凭据配好即上报。"
          style={{ marginTop: 16 }}
        />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><RocketOutlined /> 1. 快速开始</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          安装扩展包（peer 依赖 <code>@aipack-ai/agent</code>，依赖 Langfuse JS SDK v3）。可选：用官方 v4 compose 在本地自托管 Langfuse。
        </Paragraph>
        <CodeBlock code={lfQuickstartCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. 接入方式 */}
      <div id="setup" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><ApiOutlined /> 2. 接入方式</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          在 <code>createRuntime</code> 的 <code>extensions</code> 中注入 <code>LangfuseExtension</code> 即可，业务代码零改动。
        </Paragraph>
        <CodeBlock code={lfSetupCode} language="typescript" />
        <Title level={4} style={{ marginTop: 24 }}>配置优先级</Title>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          构造参数 &gt; <code>RuntimeOptions.config.langfuse</code> &gt; <code>LANGFUSE_*</code> 环境变量。
        </Paragraph>
        <CodeBlock code={lfPriorityCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. Trace 映射 */}
      <div id="mapping" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><NodeIndexOutlined /> 3. Trace 映射</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          扩展在 apply 阶段包装 Runtime Telemetry，各事件按下列规则映射到 Langfuse 对象；traceId / spanId 写入 metadata，可与框架内日志互查。
        </Paragraph>
        <CodeBlock code={lfMappingCode} language="typescript" />
        <table className="params-table" style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th style={{ width: '20%' }}>Telemetry 事件</th>
              <th style={{ width: '28%' }}>Langfuse 对象</th>
              <th>metadata 关键字段</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><span className="param-name">onRunStart</span></td><td>Trace（chain，名称 runName）</td><td>traceId / sessionKey / requestType</td></tr>
            <tr><td><span className="param-name">onModelCall</span></td><td>Generation（llm）</td><td>spanId / attempts / stream / cacheRead / cacheWrite / errorClass</td></tr>
            <tr><td><span className="param-name">onToolCall</span></td><td>TOOL observation</td><td>spanId / status / errorClass</td></tr>
            <tr><td><span className="param-name">onRunEnd</span></td><td>Trace.update</td><td>tokens / turnCount / stopReason</td></tr>
          </tbody>
        </table>
        <Alert
          type="info"
          showIcon
          message="TOOL observation 直发细节"
          description="Langfuse JS SDK v3.39 未暴露 tool-create 事件，扩展经核心 client 的 enqueue 直发 tool-create（服务端无 tool-update，end() 时一次性上报完整 body）。已验证 Langfuse v4 服务端 type=TOOL 正确落库。"
          style={{ marginTop: 16 }}
        />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. 容错与内存安全 */}
      <div id="robust" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><SafetyCertificateOutlined /> 4. 容错与内存安全</h2>
        <CodeBlock code={lfRobustCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 自定义 Transport */}
      <div id="transport" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><CodeOutlined /> 5. 自定义 Transport</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>TraceTransport</code> 抽象将扩展与 Langfuse SDK 解耦——上报实现只需遵循 <code>TracedRun</code> 最小结构面（postRun / patchRun / end / createChild），即可对接私有部署观测后端或测试离线 fake。
        </Paragraph>
        <CodeBlock code={lfCustomTransportCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. 本地自托管部署 */}
      <div id="deploy" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><CloudServerOutlined /> 6. 本地自托管部署</h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          仓库内置官方 v4 compose（<code>deploy/langfuse/docker-compose.yml</code>，6 容器），一键本地跑通；示例脚本 <code>pnpm example:langfuse</code> 演示工具调用循环 + 纯对话两条 run 的完整上报。
        </Paragraph>
        <CodeBlock code={lfDeployCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. 配置全览 */}
      <div id="config" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title"><SettingOutlined /> 7. 配置全览</h2>
        <CodeBlock code={lfOptionsCode} language="typescript" />
        <Alert
          type="warning"
          showIcon
          message="版本要求"
          description="ExtensionContext.telemetry 访问器需 @aipack-ai/agent >= 1.3.1（apply 阶段经 getTelemetry/setTelemetry 包装，emitter 实例不变、替换透明）。访问器缺失时扩展报错且不生效，主流程不受影响。"
          style={{ marginTop: 16 }}
        />
      </div>

      <Divider />
      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 与其他观测方案的分工</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>想用 <b>Langfuse 生态</b>（Prompt 管理 / 数据集 / 评估 / 团队协作） → <b>LangfuseExtension</b>（本章）</li>
          <li>想要<b>自建轻量埋点 + 聚合 + 告警</b> → <b>@aipack-ai/observability</b> + <b>observability-server</b>（可观测性章节）</li>
          <li>两者可共存：LangfuseExtension 包装底层 Telemetry 时始终转发原实现，原有上报不受影响</li>
        </ul>
      </div>
    </div>
  );
}
