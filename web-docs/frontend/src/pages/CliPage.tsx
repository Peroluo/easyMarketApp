import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Card, Row, Col, Divider, Typography } from 'antd';
import {
  ToolOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  DatabaseOutlined,
  SafetyCertificateOutlined,
  BulbOutlined,
  ApiOutlined,
  ApartmentOutlined,
  CodeOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import CodeBlock from '../components/CodeBlock';
import {
  cliInstallCode,
  cliModesCode,
  cliToolsTableCode,
  cliSubagentsCode,
  cliMemoryFilesCode,
  cliConfigCode,
  cliHooksCode,
  cliCompactionCode,
  cliSlashCommandsCode,
  cliPermissionCode,
  cliApiCode,
  cliEnvCode,
} from '../data/cliCode';

const { Paragraph } = Typography;

const featureCards = [
  {
    icon: <ToolOutlined />,
    title: '三种运行模式',
    desc: '交互 REPL / 非交互管道 / JSON 事件流，一套命令覆盖人工与程序消费',
  },
  {
    icon: <ThunderboltOutlined />,
    title: '内置 8 个工具',
    desc: 'read / write / edit / bash / find / grep / ls / task，文件工具全部工作区防护',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '智能权限',
    desc: '正常操作零打断，仅危险命令（sudo、rm -rf ~ 等）方向键选择器确认',
  },
  {
    icon: <ApartmentOutlined />,
    title: '子 agent（task）',
    desc: '隔离上下文执行子任务并只返回报告，同回合并行、防递归、权限复用',
  },
  {
    icon: <FileTextOutlined />,
    title: '项目记忆文件',
    desc: 'AIPACK.md > AGENTS.md > CLAUDE.md 自动注入系统提示词，/init 自动生成',
  },
  {
    icon: <DatabaseOutlined />,
    title: '策略管道上下文压缩',
    desc: '统一预算双水位调度：trim 无损裁剪 → summarize 摘要 → truncate 保底，长会话不溢出',
  },
];

export default function CliPage() {
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
        <ToolOutlined style={{ color: '#6366f1' }} /> CLI 命令行工具
      </h1>
      <p className="section-subtitle">
        <b>@aipack-ai/cli</b> 基于 aipack 框架的终端 AI 编程助手。内置文件读写、shell、检索与
        task 子 agent 工具，支持项目记忆文件、Skills、MCP、Hooks 与策略管道上下文压缩；
        默认权限策略对正常操作零打断、仅危险命令需确认。
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
      </div>

      {/* 1. 安装与快速开始 */}
      <div id="quickstart" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <RocketOutlined /> 1. 安装与快速开始
        </h2>
        <CodeBlock code={cliInstallCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 2. 三种运行模式 */}
      <div id="modes" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ThunderboltOutlined /> 2. 三种运行模式与常用选项
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>aipack</code>（交互 REPL）、<code>aipack -p</code>（非交互单次，回复写 stdout 可管道）、
          <code>aipack --mode json</code>（JSON 事件流）。管道 stdin 未指定 <code>-p</code> 时自动降级
          print 模式并提示；<code>@file</code> 附带上下文（图片自动走多模态通道，非视觉模型预检警告）。
        </Paragraph>
        <CodeBlock code={cliModesCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 3. 内置工具 */}
      <div id="tools" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <CodeOutlined /> 3. 内置工具
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          白名单 <code>-t</code> / 黑名单 <code>-xt</code> / 全禁 <code>-nt</code> 控制工具集，
          未知工具名会明确告警而非静默失效。
        </Paragraph>
        <CodeBlock code={cliToolsTableCode} language="text" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 4. 子 agent 与 task 工具 */}
      <div id="subagents" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ApartmentOutlined /> 4. 子 agent 与 task 工具
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>task</code> 工具让模型启动<b>隔离上下文</b>的子 agent：独立消息历史与系统提示词，
          运行结束后仅把最终报告返回主对话——检索/分析产生的大量工具输出不污染主上下文。
        </Paragraph>
        <CodeBlock code={cliSubagentsCode} language="javascript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 5. 项目记忆文件 */}
      <div id="memory" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <FileTextOutlined /> 5. 项目记忆文件
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          启动时自动加载 <code>~/.aipack/AIPACK.md</code>（用户级）与项目级
          <code> AIPACK.md &gt; AGENTS.md &gt; CLAUDE.md</code>（取第一个存在的，兼容既有生态），
          注入系统提示词尾部让模型遵循既定约定。
        </Paragraph>
        <CodeBlock code={cliMemoryFilesCode} language="markdown" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 6. 配置文件 */}
      <div id="config" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <FolderOpenOutlined /> 6. 配置文件 aipack.config.js
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          放在项目根目录（可选，也支持 <code>.mjs</code>）。优先级：
          <code>approvals</code>（pending）&gt; <code>--safe</code>（confirm）&gt; 智能默认；
          <code>permissionRules</code> 永远最先匹配。
        </Paragraph>
        <CodeBlock code={cliConfigCode} language="javascript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 7. Hooks */}
      <div id="hooks" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <BulbOutlined /> 7. Hooks（生命周期钩子）
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          命名对齐 Claude Code：命令经 <code>/bin/sh -c</code> 执行、stdin 收 JSON 事件；
          退出码 2 阻断，stdout JSON 返回决策；失败或超时仅告警不中断。
        </Paragraph>
        <CodeBlock code={cliHooksCode} language="javascript" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 8. 上下文压缩 */}
      <div id="compaction" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <DatabaseOutlined /> 8. 上下文压缩
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          压缩策略管道作为 runtime 降级链的第一级（压缩管道 → 内置摘要压缩 → 硬截断兜底）。
          统一预算 = contextWindow − 输出预留 − 安全边距；双水位调度：70% 预警时后台预压缩、
          80% 触发压到 40%。压不下去时发出上下文耗尽事件（交接文档 + 建议新会话，换会话决策归调用方）。
        </Paragraph>
        <CodeBlock code={cliCompactionCode} language="bash" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 9. 斜杠命令与会话 */}
      <div id="commands" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ToolOutlined /> 9. 斜杠命令与会话
        </h2>
        <CodeBlock code={cliSlashCommandsCode} language="text" />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 10. 默认权限策略 */}
      <div id="permissions" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <SafetyCertificateOutlined /> 10. 默认权限策略
        </h2>
        <CodeBlock code={cliPermissionCode} language="text" />
        <Alert
          type="info"
          showIcon
          message="危险命令每次重新确认"
          description="「总是允许」只对非危险命令（如 --safe 模式下的常规命令）生效；危险命令（rm / sudo / 磁盘写入 / 远程脚本管道等）每次都会重新询问。"
          style={{ marginTop: 16 }}
        />
      </div>

      <Divider style={{ margin: '40px 0' }} />

      {/* 11. 可编程 API */}
      <div id="api" style={{ scrollMarginTop: 100 }}>
        <h2 className="subsection-title">
          <ApiOutlined /> 11. 可编程 API 与环境变量
        </h2>
        <Paragraph style={{ lineHeight: 1.8, color: '#475569' }}>
          <code>@aipack-ai/cli</code> 同时导出参数解析、Runtime 组装与运行模式，可在自己的 Node 程序里复用整套 CLI 能力。
        </Paragraph>
        <CodeBlock code={cliApiCode} language="typescript" />
        <CodeBlock code={cliEnvCode} language="bash" />
        <Paragraph style={{ lineHeight: 1.8, color: '#475569', marginTop: 16 }}>
          <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />
          bash 工具子进程环境变量走白名单透传（API Key 不泄露给任意 shell 命令），
          需要暴露自定义变量时使用 <code>AIPACK_</code> 前缀。
        </Paragraph>
      </div>
    </div>
  );
}
