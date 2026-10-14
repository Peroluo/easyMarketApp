import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Card, Row, Col, Divider, Typography } from 'antd';
import {
  AimOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  ExperimentOutlined,
  SafetyCertificateOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  AlertOutlined,
  LineChartOutlined,
  SettingOutlined,
  ScissorOutlined,
  ForkOutlined,
  FileTextOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  compQuickstartCode,
  compPipelineCode,
  compBudgetCode,
  compTrimCode,
  compSummarizeCode,
  compTruncateCode,
  compPrecompressCode,
  compLifecycleCode,
  compTelemetryCode,
  compConfigCode,
  compEnvCode,
} from '../data/compressionCode';

const { Title, Paragraph } = Typography;

const featureCards = [
  {
    icon: <AimOutlined />,
    title: '统一预算',
    desc: 'effectiveBudget = contextWindow − 输出预留 − 安全边距，避免压到 95% 后模型无输出空间导致 provider 400',
  },
  {
    icon: <ThunderboltOutlined />,
    title: '双水位调度',
    desc: '70% 预警后台预压缩 → 80% 触发同步压缩 → 一次压到 40%，摊薄未来多个 turn',
  },
  {
    icon: <ForkOutlined />,
    title: '策略管道',
    desc: 'trim（无损）→ summarize（有损，map-reduce）→ truncate（保底），达标即停',
  },
  {
    icon: <CloudSyncOutlined />,
    title: '异步预压缩',
    desc: '低预警线后台 fork 生成摘要，高水位直接应用，请求路径零 fork',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '契约安全',
    desc: '摘要存完整 Message 对象满足 round-trip 契约；每策略独立工具对配对校验',
  },
  {
    icon: <AlertOutlined />,
    title: '上下文耗尽事件',
    desc: '压不下去时发事件 + 交接文档 + 建议新会话，检查点/换会话决策归 host',
  },
];

export default function CompressionPage() {
  const location = useLocation();

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
        <AimOutlined style={{ color: '#6366f1' }} /> 上下文压缩
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/compression</b> 是策略管道上下文压缩：统一预算 + 双水位调度，
        trim 无损裁剪 → summarize 有损摘要 → truncate 硬截断保底。
        压不下去时发出上下文耗尽事件，检查点 / 换会话交给 host 决策。
      </p>

      {/* 特性矩阵 */}
      <div id="overview" style={{ scrollMarginTop: 100 }}>
        <Row gutter={[16, 16]} style={{ marginBottom: 32 }}>
          {featureCards.map((f, i) => (
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
          message="独立可选包"
          description="compression 是独立于核心的可选包：不注入 Runtime 则完全不参与；注入后由 loadCompressionConfig() 的 enabled（默认 true）控制开关。CLI 侧以动态 import 加载，可用 --no-compaction / --compaction-config 控制。"
          style={{ marginBottom: 32 }}
        />
      </div>

      {/* 1. 快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 1. 快速开始
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          三步接入：<code>loadCompressionConfig()</code> 载入配置、<code>createCompressionTransformer()</code> 创建转换器、
          挂到 Runtime 的 <code>transformers</code> 数组。<code>model</code> / <code>streamFn</code> / <code>contextWindow</code>
          是构造器的必填项——压缩器需要它们来决定预算并向 fork 模型发提问。
        </Paragraph>
        <CodeBlock code={compQuickstartCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. 预算模型与双水位 */}
      <div id="budget" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <AimOutlined /> 2. 预算模型与双水位
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          压缩的所有决策都基于「有效预算」而非裸 contextWindow。若以整个窗口为界，压到 95% 时
          模型一个输出 token 都放不下，provider 会直接报错；估算器又是启发式的（偏差可达 10–30%），
          所以必须扣掉输出预留和安全边距。
        </Paragraph>
        <CodeBlock code={compBudgetCode} language="typescript" />
        <Divider orientation="left">水位与判定</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>水位</th>
              <th style={{ width: '26%' }}>默认</th>
              <th>含义</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">precompressTokens</span></td>
              <td><span className="param-type">effective × 0.70</span></td>
              <td>低预警线：进入该区间且无 pending 时，后台 fork 生成摘要（不阻塞请求）</td>
            </tr>
            <tr>
              <td><span className="param-name">triggerTokens</span></td>
              <td><span className="param-type">effective × 0.80</span></td>
              <td>高水位：达到即触发同步压缩管道</td>
            </tr>
            <tr>
              <td><span className="param-name">targetTokens</span></td>
              <td><span className="param-type">effective × 0.40</span></td>
              <td>低水位：压缩目标，一次压到位以摊薄后续多轮</td>
            </tr>
            <tr>
              <td><span className="param-name">hardLimitTokens</span></td>
              <td><span className="param-type">effective × 1.00</span></td>
              <td>硬上限：truncate 兜底线；仍超过则发出上下文耗尽事件</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. 策略管道总览 */}
      <div id="pipeline" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ForkOutlined /> 3. 策略管道总览
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          每轮模型调用前，压缩器按固定顺序执行三个策略，一旦压到低水位即提前结束。
          每个策略独立做工具对配对校验，失败只回滚该策略。
        </Paragraph>

        <div className="arch-container" style={{ marginTop: 16 }}>
          <div className="arch-layers">
            <div className="arch-layer">
              <div className="arch-label">触发</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-core">
                  <ThunderboltOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>高水位</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    tokens ≥ trigger → 进入压缩管道
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">无损</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-extension">
                  <ScissorOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>trim</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    thinking 剥离 · tool_result 按 token 裁剪 · 空白规范化
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">有损</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-adapter">
                  <ExperimentOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>summarize</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    fork 模型摘要（超预算 map-reduce）· 优先消费预压缩产物
                  </div>
                </div>
              </div>
            </div>
            <div className="arch-arrow">▼</div>
            <div className="arch-layer">
              <div className="arch-label">保底</div>
              <div className="arch-boxes">
                <div className="arch-box arch-box-storage">
                  <AlertOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>truncate</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    仅超硬限时：按工具对整体丢弃最旧非 pinned 资源
                  </div>
                </div>
                <div className="arch-box arch-box-storage">
                  <AlertOutlined style={{ fontSize: 20 }} />
                  <div style={{ fontWeight: 700, marginTop: 4 }}>耗尽事件</div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                    仍超硬限 → 交接文档 + 建议新会话（归 host）
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <CodeBlock code={compPipelineCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. Trim 无损裁剪 */}
      <div id="trim" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ScissorOutlined /> 4. Trim 无损裁剪
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          Trim 是首个策略，做三类无损操作：剥离 <code>thinking</code> 块、按 token 预算裁剪超大 <code>tool_result</code>、
          空白规范化。扫描顺序是 tail → head，释放够即停——未触及的旧前缀原样保留，最大程度保住 KV cache。
          裁剪按 token（而非行数）判定，单行 minified JSON / base64 同属常见巨型输出，也会走到字符级截断。
        </Paragraph>
        <CodeBlock code={compTrimCode} language="typescript" />
        <Divider orientation="left">trim 配置项</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '26%' }}>字段</th>
              <th style={{ width: '16%' }}>类型</th>
              <th style={{ width: '14%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">stripThinking</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>剥离 assistant_message 的 thinking 块</td>
            </tr>
            <tr>
              <td><span className="param-name">trimToolResults</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>超预算的 tool_result 按 token 裁剪</td>
            </tr>
            <tr>
              <td><span className="param-name">normalizeWhitespace</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>合并 3+ 连续换行、去行尾空格</td>
            </tr>
            <tr>
              <td><span className="param-name">toolResultMaxTokens</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>2000</code></td>
              <td>单个 tool_result 的 token 预算</td>
            </tr>
            <tr>
              <td><span className="param-name">toolResultHeadLines</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>10</code></td>
              <td>行级裁剪：保留头部行数</td>
            </tr>
            <tr>
              <td><span className="param-name">toolResultTailLines</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>10</code></td>
              <td>行级裁剪：保留尾部行数</td>
            </tr>
            <tr>
              <td><span className="param-name">keyLineLimit</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>5</code></td>
              <td>额外保留 error / fail / exception 等关键行上限</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. Summarize 有损摘要 */}
      <div id="summarize" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ExperimentOutlined /> 5. Summarize 有损摘要
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          Summarize 把旧消息 fork 给模型摘要，替换为单条 <code>compaction_summary</code> 资源。
          摘要资源的 content 存的是完整 Message 对象（<code>role="compactionSummary"</code>），
          满足 agent 包 <code>resourcesToMessages</code> 的往返契约，不会让 provider 侧崩溃。
          输入超过 fork 模型可用窗口时自动 map-reduce 分块；输出被 <code>forkMaxTokens</code> 截断（stopReason=length）即判失败，
          半截摘要不会进入上下文。
        </Paragraph>
        <CodeBlock code={compSummarizeCode} language="typescript" />
        <Divider orientation="left">summarize 配置项</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '26%' }}>字段</th>
              <th style={{ width: '16%' }}>类型</th>
              <th style={{ width: '14%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">forkModel</span></td>
              <td><span className="param-type">string?</span></td>
              <td>—</td>
              <td>摘要专用模型（缺省复用主模型）</td>
            </tr>
            <tr>
              <td><span className="param-name">forkMaxTokens</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>2048</code></td>
              <td>摘要输出上限，被截断即判失败</td>
            </tr>
            <tr>
              <td><span className="param-name">minResourcesToCompress</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>4</code></td>
              <td>可压缩资源少于该数则跳过摘要</td>
            </tr>
            <tr>
              <td><span className="param-name">protectedRecentCount</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>6</code></td>
              <td>保护最近 N 条资源不参与摘要</td>
            </tr>
            <tr>
              <td><span className="param-name">maxChunkTokens</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>24000</code></td>
              <td>map-reduce 单块 transcript 预算（0=按 fork 窗口自动决定）</td>
            </tr>
            <tr>
              <td><span className="param-name">pinnedReSummarizeRatio</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.05</code></td>
              <td>旧 pinned 摘要总量超 effective×该值时并入本次一并再压缩</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. Truncate 硬截断保底 */}
      <div id="truncate" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <AlertOutlined /> 6. Truncate 硬截断保底
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          Truncate 是确定性、无 fork 依赖的兜底，仅当前两个策略后仍超硬上限时触发。
          它从最旧开始丢弃非 pinned 资源，但工具对（发起方 + tool_result）作为整体丢弃，绝不产生悬空 tool_call；
          pinned 与保护区（最近 <code>minWorkingSet</code> 条非 pinned）永不丢。丢弃判定用不动点求解依赖闭包，
          一个 assistant_message 可属多个工具对，链条式阻塞由迭代自然传播。
        </Paragraph>
        <CodeBlock code={compTruncateCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. 异步预压缩 */}
      <div id="precompress" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CloudSyncOutlined /> 7. 异步预压缩
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          高水位同步压缩有个代价：请求路径上要等一次 fork。双水位的低预警线把这份工作提前——
          进入预压缩区间时，后台 fork 生成摘要并存入会话级 pending；真正到达高水位时直接应用该产物，
          请求路径零 fork。产物有效期 8 个 turn，应用前会再校验来源资源是否仍完整，失效即作废重生成。
        </Paragraph>
        <CodeBlock code={compPrecompressCode} language="typescript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. 上下文耗尽事件 */}
      <div id="lifecycle" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <AlertOutlined /> 8. 上下文耗尽事件
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          当 truncate 之后仍超硬上限（通常是 pinned 或保护窗口本身超限），压缩器不再尝试自己换会话，
          而是发出 <code>ContextExhaustedEvent</code>：携带尽力生成的交接文档和建议的新会话 id，
          由 host 决定是否落检查点 / 切换会话。压缩器自身没有「永久禁用」状态。
        </Paragraph>
        <CodeBlock code={compLifecycleCode} language="typescript" />
        <Divider orientation="left">ContextExhaustedEvent 字段</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '24%' }}>字段</th>
              <th style={{ width: '24%' }}>类型</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">reason</span></td>
              <td><span className="param-type">ExhaustedReason</span></td>
              <td><code>pinned_overload</code>（pinned 本身超限）或 <code>protected_overload</code>（保护窗口超限）</td>
            </tr>
            <tr>
              <td><span className="param-name">tokensAfter</span></td>
              <td><span className="param-type">number</span></td>
              <td>压缩后仍超出的 token 估算值</td>
            </tr>
            <tr>
              <td><span className="param-name">hardLimitTokens</span></td>
              <td><span className="param-type">number</span></td>
              <td>硬上限（= effectiveBudget）</td>
            </tr>
            <tr>
              <td><span className="param-name">handoffDocument</span></td>
              <td><span className="param-type">string</span></td>
              <td>交接文档（fork 生成；fork 失败/关闭时为确定性 fallback）</td>
            </tr>
            <tr>
              <td><span className="param-name">fallback</span></td>
              <td><span className="param-type">boolean</span></td>
              <td>handoffDocument 是否为 fallback（fork 未成功）</td>
            </tr>
            <tr>
              <td><span className="param-name">suggestedSessionId</span></td>
              <td><span className="param-type">string</span></td>
              <td>建议的新会话 id（host 决定是否采用）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 9. 遥测与观测 */}
      <div id="telemetry" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <LineChartOutlined /> 9. 遥测与观测
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          压缩动作全程埋点。两种接法：直接给转换器注入 <code>telemetryReporter</code>，
          或注入 <code>sharedMap</code> 由 <code>CompressionTelemetryExtension</code> 在 <code>afterTransform</code> 阶段读取上报
          （读后清空，防重复上报）。
        </Paragraph>
        <CodeBlock code={compTelemetryCode} language="typescript" />
        <Divider orientation="left">CompressionTelemetry 关键字段</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '26%' }}>字段</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">stage</span></td>
              <td>precompress / trim / summarize / truncate / lifecycle / dry_run</td>
            </tr>
            <tr>
              <td><span className="param-name">action</span></td>
              <td>动作标识（如 trim_lossless / summarize_history / context_exhausted）</td>
            </tr>
            <tr>
              <td><span className="param-name">beforeTokens / afterTokens</span></td>
              <td>动作前后的 token 估算</td>
            </tr>
            <tr>
              <td><span className="param-name">prefixIntact</span></td>
              <td>KV cache 保持的前缀资源数（首个被修改/删除资源之前的资源数）</td>
            </tr>
            <tr>
              <td><span className="param-name">rolledBack / failed / message</span></td>
              <td>是否回滚（配对校验失败）、是否失败、附加上下文信息</td>
            </tr>
            <tr>
              <td><span className="param-name">forkDurationMs / forkRetries / forkModelId / forkTruncated</span></td>
              <td>fork 调用耗时、重试次数、实际模型 id、输出是否被截断</td>
            </tr>
            <tr>
              <td><span className="param-name">topContributors</span></td>
              <td>触发时 token 占比最高的资源（前 3，运维定位"哪个工具刷屏"）</td>
            </tr>
            <tr>
              <td><span className="param-name">messageCountBefore / messageCountAfter</span></td>
              <td>压缩前后的资源条数</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 10. 配置全览 */}
      <div id="config" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SettingOutlined /> 10. 配置全览（CompressionConfig）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>loadCompressionConfig(overrides?)</code> 返回「默认值 + 覆盖项」的完整配置。
          传入的是 <code>DeepPartial&lt;CompressionConfig&gt;</code>，可只写要改的嵌套字段。
          构造器启动时会 <code>validateConfig</code> 校验（默认只 warn，不阻塞启动）。
        </Paragraph>
        <CodeBlock code={compConfigCode} language="typescript" />
        <Divider orientation="left">字段默认值</Divider>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>字段</th>
              <th style={{ width: '16%' }}>类型</th>
              <th style={{ width: '16%' }}>默认</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">enabled</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>总开关，关闭则原样透传</td>
            </tr>
            <tr>
              <td><span className="param-name">estimator.charsPerTokenAscii</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>4</code></td>
              <td>ASCII 字符 / token</td>
            </tr>
            <tr>
              <td><span className="param-name">estimator.charsPerTokenCJK</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>1.5</code></td>
              <td>中日韩字符 / token</td>
            </tr>
            <tr>
              <td><span className="param-name">estimator.imageTokensPerBlock</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>1500</code></td>
              <td>每个图片块的估算 token</td>
            </tr>
            <tr>
              <td><span className="param-name">estimator.cacheCapacity</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>1000</code></td>
              <td>string 估算缓存容量</td>
            </tr>
            <tr>
              <td><span className="param-name">budget.outputReserveTokens</span></td>
              <td><span className="param-type">number?</span></td>
              <td><code>model.maxTokens</code></td>
              <td>输出预留；显式 0 表示不预留（不推荐）</td>
            </tr>
            <tr>
              <td><span className="param-name">budget.safetyMarginRatio</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.05</code></td>
              <td>安全边距比例</td>
            </tr>
            <tr>
              <td><span className="param-name">budget.triggerRatio</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.80</code></td>
              <td>高水位</td>
            </tr>
            <tr>
              <td><span className="param-name">budget.targetRatio</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.40</code></td>
              <td>低水位（须 &lt; triggerRatio）</td>
            </tr>
            <tr>
              <td><span className="param-name">budget.precompressRatio</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>0.70</code></td>
              <td>预压缩线（须 &lt; triggerRatio）</td>
            </tr>
            <tr>
              <td><span className="param-name">trim.*</span></td>
              <td><span className="param-type">object</span></td>
              <td>见上文</td>
              <td>无损裁剪策略配置（enabled 默认 true）</td>
            </tr>
            <tr>
              <td><span className="param-name">summarize.*</span></td>
              <td><span className="param-type">object</span></td>
              <td>见上文</td>
              <td>有损摘要策略配置（enabled 默认 true）</td>
            </tr>
            <tr>
              <td><span className="param-name">truncate.enabled</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>硬截断保底开关</td>
            </tr>
            <tr>
              <td><span className="param-name">truncate.minWorkingSet</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>2</code></td>
              <td>保护区大小（非 pinned）</td>
            </tr>
            <tr>
              <td><span className="param-name">lifecycle.enabled</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>耗尽时是否 fork 生成交接文档（关闭则直接 fallback）</td>
            </tr>
            <tr>
              <td><span className="param-name">lifecycle.forkModel / forkMaxTokens</span></td>
              <td><span className="param-type">string? / number</span></td>
              <td><code>— / 2048</code></td>
              <td>交接文档 fork 模型与输出上限</td>
            </tr>
            <tr>
              <td><span className="param-name">safety.maxAttempts</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>5</code></td>
              <td>单 turn 内最大压缩尝试次数（跨 turn 重置）</td>
            </tr>
            <tr>
              <td><span className="param-name">safety.cooldownTurns</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>3</code></td>
              <td>尝试耗尽后的冷却 turn 数（失败退避，无永久禁用）</td>
            </tr>
            <tr>
              <td><span className="param-name">safety.forkTimeoutMs</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>30000</code></td>
              <td>单次 fork 超时</td>
            </tr>
            <tr>
              <td><span className="param-name">safety.retry.retries / baseMs / maxMs</span></td>
              <td><span className="param-type">number</span></td>
              <td><code>2 / 500 / 4000</code></td>
              <td>fork 重试次数与指数退避区间</td>
            </tr>
            <tr>
              <td><span className="param-name">safety.serializePerSession</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>同 session 强制串行化（promise 链原子交接，真互斥）</td>
            </tr>
            <tr>
              <td><span className="param-name">dryRun</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>false</code></td>
              <td>只算 token + 生成遥测，不修改资源（灰度/调参）</td>
            </tr>
            <tr>
              <td><span className="param-name">telemetry.enabled</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true</code></td>
              <td>遥测开关</td>
            </tr>
            <tr>
              <td><span className="param-name">telemetry.logTokenDelta / logTriggerReason</span></td>
              <td><span className="param-type">boolean</span></td>
              <td><code>true / true</code></td>
              <td>控制台上报器是否输出 token 差值与触发原因</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 11. 环境变量 */}
      <div id="env" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 11. 环境变量
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          每个配置项都有对应环境变量，优先级低于代码里的 <code>overrides</code>。
          显式设置 <code>0</code> 也生效（这点修复了旧实现 <code>Number(env.X) || default</code> 无法置 0 的问题）。
        </Paragraph>
        <CodeBlock code={compEnvCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 12. 适用场景与调优 */}
      <div id="when" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DashboardOutlined /> 12. 适用场景与调参建议
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          压缩不是越省越好：过度压缩会丢失上下文导致回答质量下降，过于保守又会在长任务里频繁触发。
          先用 <code>dryRun</code> 观察真实触发频率，再按场景调整下面几组旋钮。
        </Paragraph>
        <table className="params-table">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>目标</th>
              <th>建议</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="param-name">省 token / 少 fork</span></td>
              <td>下调 <code>targetRatio</code>（如 0.30），一次压更狠；或上调 <code>precompressRatio</code> 让后台预压缩更早介入</td>
            </tr>
            <tr>
              <td><span className="param-name">保质量 / 少打扰模型</span></td>
              <td>上调 <code>protectedRecentCount</code> 与 <code>targetRatio</code>，只做 trim 无损裁剪，必要时把 summarize.forkModel 换成更强模型</td>
            </tr>
            <tr>
              <td><span className="param-name">放宽响应性</span></td>
              <td>保持默认双水位即可：预压缩把 fork 移出请求路径，用户体验接近零等待</td>
            </tr>
            <tr>
              <td><span className="param-name">观测 / 灰度</span></td>
              <td>开 <code>dryRun</code> 只看遥测；接 <code>telemetryReporter</code> 或 <code>CompressionTelemetryExtension</code> 落到可观测平台</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Divider />

      <div style={{ padding: 24, background: '#f0fdf4', borderRadius: 12, border: '1px solid #bbf7d0' }}>
        <h3 style={{ marginTop: 0, color: '#166534' }}>💡 关键点速查</h3>
        <ul style={{ color: '#14532d', lineHeight: 2 }}>
          <li>预算是地基 → <b>effectiveBudget = contextWindow − 输出预留 − 安全边距</b>，绝不以裸窗口为界</li>
          <li>双水位 → <b>70% 预压缩 / 80% 触发 / 40% 压到位</b>，一次压到位摊薄后续 turn</li>
          <li>策略管道 → <b>trim 无损 → summarize 有损 → truncate 保底</b>，达标即停</li>
          <li>契约安全 → 摘要存完整 Message 对象；每策略独立工具对配对校验，失败只回滚该策略</li>
          <li>耗尽归属 → 压缩器只发 <b>ContextExhaustedEvent</b> + 交接文档，换会话由 host 决策</li>
          <li>调参先灰度 → <b>dryRun</b> 看遥测，再决定压多狠</li>
        </ul>
      </div>

      <div style={{ height: 80 }} />
    </div>
  );
}
