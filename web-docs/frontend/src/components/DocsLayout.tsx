import { ReactNode, useMemo, useEffect, useState } from 'react';
import { Menu, Drawer } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import { UnorderedListOutlined } from '@ant-design/icons';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  RocketOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  ExperimentOutlined,
  BoxPlotOutlined,
  SettingOutlined,
  DatabaseOutlined,
  RobotOutlined,
  AppstoreOutlined,
  SafetyCertificateOutlined,
  AimOutlined,
  LineChartOutlined,
  CloudServerOutlined,
  NodeIndexOutlined,
  DashboardOutlined,
  BellOutlined,
  DollarOutlined,
  CloudUploadOutlined,
  ClockCircleOutlined,
  ApartmentOutlined,
  ForkOutlined,
  ShareAltOutlined,
  DeploymentUnitOutlined,
  BugOutlined,
  TagsOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  BulbOutlined,
  WarningOutlined,
  ToolOutlined,
} from '@ant-design/icons';

interface DocsLayoutProps {
  children: ReactNode;
}

interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  type?: 'group';
  children?: MenuItem[];
}

// 递归查找菜单项（支持嵌套 children / type='group'）
function findMenuItem(
  items: MenuItem[],
  predicate: (m: MenuItem) => boolean,
): MenuItem | undefined {
  for (const m of items) {
    if (predicate(m)) return m;
    if (m.children) {
      const hit = findMenuItem(m.children, predicate);
      if (hit) return hit;
    }
  }
  return undefined;
}

const quickstartMenu: MenuItem[] = [
  { key: '/quickstart', label: '安装与配置', icon: <ThunderboltOutlined /> },
  { key: '/quickstart#first-app', label: '创建第一个应用', icon: <RocketOutlined /> },
  { key: '/quickstart#streaming', label: '流式响应', icon: <AimOutlined /> },
  { key: '/quickstart#multi-turn', label: '多轮对话', icon: <BoxPlotOutlined /> },
];

const cliMenu: MenuItem[] = [
  { key: '/cli#overview', label: '总览', icon: <RocketOutlined /> },
  { key: '/cli#quickstart', label: '1. 安装与快速开始', icon: <ThunderboltOutlined /> },
  { key: '/cli#modes', label: '2. 三种运行模式', icon: <CodeOutlined /> },
  { key: '/cli#tools', label: '3. 内置工具', icon: <ToolOutlined /> },
  { key: '/cli#subagents', label: '4. 子 agent（task）', icon: <ApartmentOutlined /> },
  { key: '/cli#memory', label: '5. 项目记忆文件', icon: <FileTextOutlined /> },
  { key: '/cli#config', label: '6. aipack.config.js', icon: <SettingOutlined /> },
  { key: '/cli#hooks', label: '7. Hooks', icon: <BulbOutlined /> },
  { key: '/cli#compaction', label: '8. 上下文压缩', icon: <DatabaseOutlined /> },
  { key: '/cli#commands', label: '9. 斜杠命令与会话', icon: <FolderOpenOutlined /> },
  { key: '/cli#permissions', label: '10. 默认权限策略', icon: <SafetyCertificateOutlined /> },
  { key: '/cli#api', label: '11. 可编程 API', icon: <ApiOutlined /> },
];

const apiMenu: MenuItem[] = [
  { key: '/api#runtime', label: 'Runtime 核心', icon: <RobotOutlined /> },
  { key: '/api#request', label: 'Request 请求', icon: <ThunderboltOutlined /> },
  { key: '/api#session', label: 'Session 会话', icon: <DatabaseOutlined /> },
  { key: '/api#sessions', label: '多会话管理', icon: <BoxPlotOutlined /> },
  { key: '/api#permission', label: '权限安全', icon: <SafetyCertificateOutlined /> },
  { key: '/api#ai', label: 'AI 模型层', icon: <AppstoreOutlined /> },
  { key: '/api#extension', label: 'Extension 扩展', icon: <SettingOutlined /> },
  { key: '/api#transformer', label: 'Transformer 转换器', icon: <CodeOutlined /> },
  { key: '/api#result', label: 'Result 结果', icon: <ApiOutlined /> },
];

const extendMenu: MenuItem[] = [
  { key: '/extend', label: '扩展机制总览', icon: <SettingOutlined /> },
  { key: '/extend#tool', label: '自定义工具', icon: <CodeOutlined /> },
  { key: '/extend#extension', label: '自定义 Extension', icon: <ExperimentOutlined /> },
  { key: '/extend#transformer', label: '自定义 Transformer', icon: <BoxPlotOutlined /> },
  { key: '/extend#hooks', label: '工具调用钩子', icon: <SafetyCertificateOutlined /> },
];

const observabilityMenu: MenuItem[] = [
  // ── SDK 埋点（@aipack-ai/observability） ──
  {
    key: 'group-sdk',
    type: 'group',
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <LineChartOutlined /> SDK 埋点
      </span>
    ),
    children: [
      { key: '/observability#sdk-overview', label: '总览', icon: <RocketOutlined /> },
      { key: '/observability#setup', label: '1. 接入方式', icon: <ApiOutlined /> },
      { key: '/observability#events', label: '2. 事件一览', icon: <DashboardOutlined /> },
      { key: '/observability#trace', label: '3. Trace 设计', icon: <NodeIndexOutlined /> },
      { key: '/observability#metrics', label: '4. 生产指标口径', icon: <AimOutlined /> },
      { key: '/observability#s2', label: '5. 埋点上报与后台收集', icon: <DatabaseOutlined /> },
      { key: '/observability#sampling', label: '6. 采样策略（P9）', icon: <BulbOutlined /> },
      { key: '/observability#w3c', label: '7. W3C Trace Context（P9）', icon: <NodeIndexOutlined /> },
      { key: '/observability#redact', label: '8. PII 脱敏与 OTLP（P9）', icon: <SafetyCertificateOutlined /> },
    ],
  },
  // ── Server 部署（@aipack-ai/observability-server） ──
  {
    key: 'group-server',
    type: 'group',
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <CloudServerOutlined /> Server 部署
      </span>
    ),
    children: [
      { key: '/observability#server-overview', label: '总览', icon: <RocketOutlined /> },
      { key: '/observability#quickstart', label: '1. 快速开始', icon: <RocketOutlined /> },
      { key: '/observability#architecture', label: '2. 架构总览', icon: <ExperimentOutlined /> },
      { key: '/observability#storage', label: '3. 存储与聚合', icon: <DatabaseOutlined /> },
      { key: '/observability#api', label: '4. REST API', icon: <ApiOutlined /> },
      { key: '/observability#auth', label: '5. 用户与 RBAC', icon: <SafetyCertificateOutlined /> },
      { key: '/observability#alerts', label: '6. 告警系统', icon: <BellOutlined /> },
      { key: '/observability#cost', label: '7. 成本核算', icon: <DollarOutlined /> },
      { key: '/observability#archive', label: '8. 冷数据归档', icon: <CloudUploadOutlined /> },
      { key: '/observability#retention', label: '9. 数据保留', icon: <DatabaseOutlined /> },
      { key: '/observability#dashboard', label: '10. 内置面板', icon: <DashboardOutlined /> },
    ],
  },
];

const memoryMenu: MenuItem[] = [
  { key: '/memory#overview', label: '总览', icon: <RocketOutlined /> },
  { key: '/memory#quickstart', label: '1. 快速开始', icon: <ThunderboltOutlined /> },
  { key: '/memory#pipeline', label: '2. 数据流闭环', icon: <ApiOutlined /> },
  { key: '/memory#capture', label: '3. 自动捕获', icon: <DatabaseOutlined /> },
  { key: '/memory#injection', label: '4. 自动注入', icon: <ThunderboltOutlined /> },
  { key: '/memory#retrieval', label: '5. 混合检索', icon: <AimOutlined /> },
  { key: '/memory#tools', label: '6. Agent 工具', icon: <CodeOutlined /> },
  { key: '/memory#consolidation', label: '7. 记忆合并与修剪', icon: <ExperimentOutlined /> },
  { key: '/memory#ttl', label: '8. TTL 过期', icon: <ClockCircleOutlined /> },
  { key: '/memory#store-api', label: '9. Store API', icon: <ApiOutlined /> },
  { key: '/memory#custom-store', label: '10. 自定义 Store', icon: <DatabaseOutlined /> },
  { key: '/memory#events', label: '11. 事件监控', icon: <DashboardOutlined /> },
  { key: '/memory#config', label: '12. 插件配置全览', icon: <SettingOutlined /> },
];

const skillsMenu: MenuItem[] = [
  { key: '/skills#overview', label: '总览', icon: <RocketOutlined /> },
  { key: '/skills#quickstart', label: '1. 快速开始', icon: <ThunderboltOutlined /> },
  { key: '/skills#skill-md', label: '2. SKILL.md 格式', icon: <FileTextOutlined /> },
  { key: '/skills#layout', label: '3. 目录与发现规则', icon: <FolderOpenOutlined /> },
  { key: '/skills#disclosure', label: '4. 渐进式披露', icon: <BulbOutlined /> },
  { key: '/skills#explicit', label: '5. 显式触发', icon: <ThunderboltOutlined /> },
  { key: '/skills#diy', label: '6. 程序化 DIY', icon: <CodeOutlined /> },
  { key: '/skills#diagnostics', label: '7. 诊断与冲突', icon: <WarningOutlined /> },
  { key: '/skills#security', label: '8. 安全与边界', icon: <SafetyCertificateOutlined /> },
];

const mcpMenu: MenuItem[] = [
  { key: '/mcp#overview', label: '总览', icon: <RocketOutlined /> },
  { key: '/mcp#quickstart', label: '1. 快速开始', icon: <ThunderboltOutlined /> },
  { key: '/mcp#config', label: '2. .mcp.json 配置', icon: <SettingOutlined /> },
  { key: '/mcp#server-config', label: '3. Server 配置项', icon: <ApiOutlined /> },
  { key: '/mcp#transports', label: '4. 传输层', icon: <ShareAltOutlined /> },
  { key: '/mcp#lifecycle', label: '5. 连接生命周期', icon: <DeploymentUnitOutlined /> },
  { key: '/mcp#protocol', label: '6. 协议与容错', icon: <CodeOutlined /> },
  { key: '/mcp#sampling', label: '7. Sampling 双向', icon: <BulbOutlined /> },
  { key: '/mcp#server', label: '8. 服务端方向', icon: <CloudServerOutlined /> },
  { key: '/mcp#security', label: '9. 安全与权限', icon: <SafetyCertificateOutlined /> },
  { key: '/mcp#cli', label: '10. CLI 集成', icon: <SettingOutlined /> },
];

const multiAgentMenu: MenuItem[] = [
  { key: '/multi-agent', label: '总览', icon: <ApartmentOutlined /> },
  { key: '/multi-agent#architecture', label: '架构总览', icon: <NodeIndexOutlined /> },
  { key: '/multi-agent#quickstart', label: '1. 快速开始', icon: <RocketOutlined /> },
  { key: '/multi-agent#concepts', label: '2. 核心概念', icon: <CodeOutlined /> },
  { key: '/multi-agent#patterns', label: '3. 编排模板', icon: <ForkOutlined /> },
  { key: '/multi-agent#pattern-pipeline', label: '3.1 Pipeline', icon: <ForkOutlined /> },
  { key: '/multi-agent#pattern-router', label: '3.2 Router', icon: <ForkOutlined /> },
  { key: '/multi-agent#pattern-supervisor', label: '3.3 Supervisor', icon: <ForkOutlined /> },
  { key: '/multi-agent#pattern-debate', label: '3.4 Debate', icon: <ForkOutlined /> },
  { key: '/multi-agent#pattern-mapreduce', label: '3.5 MapReduce', icon: <ForkOutlined /> },
  { key: '/multi-agent#custom-graph', label: '4. 自定义图', icon: <NodeIndexOutlined /> },
  { key: '/multi-agent#data-flow', label: '5. 数据流', icon: <ShareAltOutlined /> },
  { key: '/multi-agent#streaming', label: '6. 流式事件', icon: <ThunderboltOutlined /> },
  { key: '/multi-agent#mcp-bridge', label: '7. MCPBridge', icon: <DeploymentUnitOutlined /> },
  { key: '/multi-agent#debugger', label: '8. GraphDebugger', icon: <BugOutlined /> },
  { key: '/multi-agent#template-guide', label: '9. 模板选择', icon: <AimOutlined /> },
  { key: '/multi-agent#result', label: '10. 运行结果', icon: <ApiOutlined /> },
];

const compressionMenu: MenuItem[] = [
  { key: '/compression#overview', label: '总览', icon: <RocketOutlined /> },
  { key: '/compression#quickstart', label: '1. 快速开始', icon: <ThunderboltOutlined /> },
  { key: '/compression#budget', label: '2. 预算模型与双水位', icon: <AimOutlined /> },
  { key: '/compression#pipeline', label: '3. 策略管道总览', icon: <ForkOutlined /> },
  { key: '/compression#trim', label: '4. Trim 无损裁剪', icon: <CodeOutlined /> },
  { key: '/compression#summarize', label: '5. Summarize 有损摘要', icon: <ExperimentOutlined /> },
  { key: '/compression#truncate', label: '6. Truncate 硬截断保底', icon: <SafetyCertificateOutlined /> },
  { key: '/compression#precompress', label: '7. 异步预压缩', icon: <CloudUploadOutlined /> },
  { key: '/compression#lifecycle', label: '8. 上下文耗尽事件', icon: <ApiOutlined /> },
  { key: '/compression#telemetry', label: '9. 遥测与观测', icon: <LineChartOutlined /> },
  { key: '/compression#config', label: '10. 配置全览', icon: <SettingOutlined /> },
  { key: '/compression#env', label: '11. 环境变量', icon: <DatabaseOutlined /> },
  { key: '/compression#when', label: '12. 适用场景与调参', icon: <DashboardOutlined /> },
];

const evalMenu: MenuItem[] = [
  { key: '/eval#overview', label: '总览', icon: <RocketOutlined /> },
  { key: '/eval#quickstart', label: '1. 快速开始', icon: <ThunderboltOutlined /> },
  { key: '/eval#case', label: '2. 用例格式', icon: <FileTextOutlined /> },
  { key: '/eval#mock', label: '3. Mock 模式', icon: <BugOutlined /> },
  { key: '/eval#live', label: '4. Live 模式', icon: <CloudServerOutlined /> },
  { key: '/eval#scorers', label: '5. 评分器', icon: <AimOutlined /> },
  { key: '/eval#cli', label: '6. CLI 用法', icon: <CodeOutlined /> },
  { key: '/eval#baseline', label: '7. Baseline 门禁', icon: <SafetyCertificateOutlined /> },
  { key: '/eval#compare', label: '8. 模型对比', icon: <ApartmentOutlined /> },
  { key: '/eval#import', label: '9. Trace 回流', icon: <DeploymentUnitOutlined /> },
  { key: '/eval#history', label: '10. 历史趋势', icon: <LineChartOutlined /> },
  { key: '/eval#config', label: '11. RunConfig 全览', icon: <SettingOutlined /> },
];

const examplesMenu: MenuItem[] = [
  { key: '/examples', label: '最小示例', icon: <CodeOutlined /> },
  { key: '/examples#memory', label: '记忆集成', icon: <DatabaseOutlined /> },
  { key: '/examples#compression', label: '上下文压缩', icon: <AimOutlined /> },
  { key: '/examples#cli', label: 'CLI 配置', icon: <SettingOutlined /> },
  { key: '/examples#mcp', label: 'MCP 客户端', icon: <DeploymentUnitOutlined /> },
  { key: '/examples#mcp-server', label: 'MCP 服务端', icon: <CloudServerOutlined /> },
];

const packagesMenu: MenuItem[] = [
  { key: '/packages', label: '包概览', icon: <AppstoreOutlined /> },
  { key: '/packages#aipack', label: 'aipack（核心）', icon: <RocketOutlined /> },
  { key: '/packages#aipack-memory', label: 'aipack-memory', icon: <DatabaseOutlined /> },
  { key: '/packages#aipack-skills', label: 'aipack-skills', icon: <TagsOutlined /> },
  { key: '/packages#aipack-compression', label: 'aipack-compression', icon: <AimOutlined /> },
  { key: '/packages#aipack-multi-agent', label: 'aipack-multi-agent', icon: <ApartmentOutlined /> },
  { key: '/packages#aipack-mcp', label: 'aipack-mcp', icon: <DeploymentUnitOutlined /> },
  { key: '/packages#aipack-eval', label: 'aipack-eval', icon: <ExperimentOutlined /> },
  { key: '/packages#aipack-observability', label: 'aipack-observability', icon: <LineChartOutlined /> },
  { key: '/packages#aipack-observability-server', label: 'aipack-observability-server', icon: <CloudServerOutlined /> },
  { key: '/packages#aipack-cli', label: 'aipack-cli', icon: <SettingOutlined /> },
];

export default function DocsLayout({ children }: DocsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [tocOpen, setTocOpen] = useState(false);

  // 切换路由时收起移动端目录抽屉
  useEffect(() => {
    setTocOpen(false);
  }, [location.pathname]);

  const { selectedKey, openKeys, rootPath } = useMemo(() => {
    const path = location.pathname;
    let items: MenuItem[] = [];
    if (path === '/quickstart' || path.startsWith('/quickstart')) items = quickstartMenu;
    else if (path === '/cli' || path.startsWith('/cli')) items = cliMenu;
    else if (path === '/api' || path.startsWith('/api')) items = apiMenu;
    else if (path === '/extend' || path.startsWith('/extend')) items = extendMenu;
    else if (path === '/observability' || path.startsWith('/observability')) items = observabilityMenu;
    else if (path === '/memory' || path.startsWith('/memory')) items = memoryMenu;
    else if (path === '/skills' || path.startsWith('/skills')) items = skillsMenu;
    else if (path === '/mcp' || path.startsWith('/mcp')) items = mcpMenu;
    else if (path === '/eval' || path.startsWith('/eval')) items = evalMenu;
    else if (path === '/multi-agent' || path.startsWith('/multi-agent')) items = multiAgentMenu;
    else if (path === '/compression' || path.startsWith('/compression')) items = compressionMenu;
    else if (path === '/examples' || path.startsWith('/examples')) items = examplesMenu;
    else if (path === '/packages' || path.startsWith('/packages')) items = packagesMenu;
    const selected = location.pathname + (location.hash || '');
    return {
      // 精确匹配优先，支持嵌套 children/group（递归查找）
      selectedKey:
        findMenuItem(items, (m) => m.key === selected)?.key ||
        findMenuItem(items, (m) => selected.startsWith(m.key))?.key ||
        path,
      // group 类型不需要 openKeys；平铺菜单保留原行为
      openKeys: items.filter((m) => m.type !== 'group').map((m) => m.key),
      rootPath: path,
    };
  }, [location.pathname, location.hash]);

  const currentMenu = (() => {
    if (rootPath === '/quickstart') return quickstartMenu;
    if (rootPath === '/cli') return cliMenu;
    if (rootPath === '/api') return apiMenu;
    if (rootPath === '/extend') return extendMenu;
    if (rootPath === '/observability') return observabilityMenu;
    if (rootPath === '/memory') return memoryMenu;
    if (rootPath === '/skills') return skillsMenu;
    if (rootPath === '/mcp') return mcpMenu;
    if (rootPath === '/eval') return evalMenu;
    if (rootPath === '/multi-agent') return multiAgentMenu;
    if (rootPath === '/compression') return compressionMenu;
    if (rootPath === '/examples') return examplesMenu;
    if (rootPath === '/packages') return packagesMenu;
    return [];
  })();

  const handleClick = ({ key }: { key: string }) => {
    setTocOpen(false);
    const [path, hash] = key.split('#');
    const target = hash ? `${path}#${hash}` : path;
    if (target !== location.pathname + location.hash) {
      // navigate 触发 URL 变化；页面内部 useLocation().hash effect 会处理滚动
      navigate(target);
    }
    // 移动端从抽屉点击时，先等抽屉关闭动画结束（期间 body 被锁滚动）再滚
    const delay = isMobile ? 260 : 0;
    window.setTimeout(() => {
      if (!hash) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      // 纯锚点直接滚动（如果 DOM 已渲染）；页面的 useLocation effect 也会兜底
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // （若 DOM 未渲染到，页面内部 useEffect(location.hash) 会在 50ms 后再试一次）
    }, delay);
  };

  if (rootPath === '/') {
    return <>{children}</>;
  }

  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[selectedKey]}
      defaultOpenKeys={openKeys}
      onClick={handleClick}
      style={{ borderRight: 'none', background: 'transparent' }}
      items={currentMenu as any}
    />
  );

  return (
    <div className="docs-layout">
      {!isMobile && (
        <aside className="docs-sidebar">
          <div style={{ padding: '0 20px 16px', fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: 0.5 }}>
            文档导航
          </div>
          {menu}
        </aside>
      )}
      <main className="docs-content">
        {isMobile && currentMenu.length > 0 && (
          <button className="docs-toc-trigger" onClick={() => setTocOpen(true)}>
            <UnorderedListOutlined />
            <span>目录</span>
          </button>
        )}
        <div className="docs-content-inner">{children}</div>
      </main>
      <Drawer
        className="toc-drawer"
        title={<span style={{ fontWeight: 700 }}>目录</span>}
        placement="bottom"
        height="70vh"
        open={isMobile && tocOpen}
        onClose={() => setTocOpen(false)}
        styles={{ body: { padding: '8px 0 calc(16px + env(safe-area-inset-bottom))' } }}
      >
        {menu}
      </Drawer>
    </div>
  );
}
