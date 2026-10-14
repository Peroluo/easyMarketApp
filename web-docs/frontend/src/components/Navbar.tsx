import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Drawer, Dropdown } from 'antd';
import {
  GithubOutlined,
  MenuOutlined,
  BookOutlined,
  ThunderboltOutlined,
  RocketOutlined,
  CodeOutlined,
  LineChartOutlined,
  DatabaseOutlined,
  ApartmentOutlined,
  TagsOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  ToolOutlined,
  AimOutlined,
  DownOutlined,
} from '@ant-design/icons';
import { useIsMobile } from '../hooks/useIsMobile';
import Logo from './Logo';

const navItems = [
  { path: '/', label: '首页', icon: <RocketOutlined /> },
  { path: '/quickstart', label: '快速开始', icon: <ThunderboltOutlined /> },
  { path: '/cli', label: 'CLI 工具', icon: <ToolOutlined /> },
  { path: '/api', label: 'API 文档', icon: <BookOutlined /> },
  { path: '/extend', label: '扩展指南', icon: <CodeOutlined /> },
  { path: '/compression', label: '上下文压缩', icon: <AimOutlined /> },
  { path: '/observability', label: '可观测性', icon: <LineChartOutlined /> },
  { path: '/memory', label: '持久化记忆', icon: <DatabaseOutlined /> },
  { path: '/skills', label: 'Agent Skills', icon: <TagsOutlined /> },
  { path: '/multi-agent', label: '多Agent编排', icon: <ApartmentOutlined /> },
  { path: '/mcp', label: 'MCP 互操作', icon: <DeploymentUnitOutlined /> },
  { path: '/eval', label: 'Eval 评测', icon: <ExperimentOutlined /> },
  { path: '/examples', label: '示例代码', icon: <GithubOutlined /> },
  { path: '/packages', label: '包介绍', icon: <RocketOutlined /> },
];

const GITHUB_URL = 'https://github.com/luoguoxiong/aipack';

// 桌面端导航拆分：高频页面平铺，其余收进「更多」下拉，避免头部拥挤
const MORE_PATHS = ['/eval', '/mcp', '/multi-agent', '/examples', '/packages', '/observability', '/memory'];
const primaryNavItems = navItems.filter((item) => !MORE_PATHS.includes(item.path));
const moreNavItems = navItems.filter((item) => MORE_PATHS.includes(item.path));

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const currentPath = location.pathname;

  // 命中当前路由：带 hash 的直达项需路径 + hash 完全匹配
  const isItemActive = (path: string) => {
    if (path.includes('#')) return `${currentPath}${location.hash}` === path;
    return path === '/' ? currentPath === '/' : currentPath.startsWith(path);
  };

  // 路由变化（含浏览器前进/后退）时收起抽屉
  useEffect(() => {
    setMenuOpen(false);
  }, [currentPath]);

  const go = (path: string) => {
    setMenuOpen(false);
    navigate(path);
  };

  const renderNavList = () => (
    <div className="mobile-nav-list">
      {navItems.map((item) => {
        const isActive = isItemActive(item.path);
        return (
          <div
            key={item.path}
            className={`mobile-nav-item ${isActive ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => go(item.path)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') go(item.path);
            }}
          >
            <span className="mobile-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        );
      })}
      <Button
        block
        icon={<GithubOutlined />}
        style={{ marginTop: 12 }}
        onClick={() => window.open(GITHUB_URL, '_blank')}
      >
        GitHub 仓库
      </Button>
    </div>
  );

  return (
    <nav className="navbar">
      <div className="navbar-logo" onClick={() => go('/')} style={{ cursor: 'pointer' }}>
        <Logo size={isMobile ? 22 : 28} />
        <span>aipack</span>
        <span
          style={{
            fontSize: 11,
            background: '#eef2ff',
            color: '#4f46e5',
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 600,
          }}
        >
          v{__APP_VERSION__}
        </span>
      </div>

      {!isMobile && (
        <div className="navbar-links">
          {primaryNavItems.map((item) => {
            const isActive = isItemActive(item.path);
            return (
              <span
                key={item.path}
                className={`navbar-link ${isActive ? 'active' : ''}`}
                onClick={() => go(item.path)}
              >
                {item.icon} <span style={{ marginLeft: 4 }}>{item.label}</span>
              </span>
            );
          })}
          <Dropdown
            menu={{
              items: moreNavItems.map((item) => ({
                key: item.path,
                icon: item.icon,
                label: item.label,
              })),
              selectedKeys: moreNavItems
                .filter((item) => currentPath.startsWith(item.path))
                .map((item) => item.path),
              onClick: ({ key }) => go(key),
            }}
            trigger={['click', 'hover']}
          >
            <span
              className={`navbar-link navbar-link-more ${
                moreNavItems.some((item) => currentPath.startsWith(item.path)) ? 'active' : ''
              }`}
              onClick={(e) => e.preventDefault()}
            >
              更多 <DownOutlined style={{ fontSize: 10 }} />
            </span>
          </Dropdown>
        </div>
      )}

      <div className="navbar-actions">
        {!isMobile && (
          <Button
            type="default"
            icon={<GithubOutlined />}
            onClick={() => window.open(GITHUB_URL, '_blank')}
          >
            GitHub
          </Button>
        )}
        {isMobile && (
          <Button
            className="navbar-menu-btn"
            type="text"
            icon={<MenuOutlined style={{ fontSize: 20 }} />}
            aria-label="打开导航菜单"
            onClick={() => setMenuOpen(true)}
          />
        )}
      </div>

      <Drawer
        className="nav-drawer"
        title={<span style={{ fontWeight: 700 }}>文档导航</span>}
        placement="right"
        width="78%"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        styles={{ body: { padding: '8px 12px calc(16px + env(safe-area-inset-bottom))' } }}
      >
        {renderNavList()}
      </Drawer>
    </nav>
  );
}
