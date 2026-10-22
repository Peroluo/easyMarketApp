import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import DocsLayout from './components/DocsLayout';
import HomePage from './pages/HomePage';
import QuickstartPage from './pages/QuickstartPage';
import CliPage from './pages/CliPage';
import ApiPage from './pages/ApiPage';
import ExtendPage from './pages/ExtendPage';
import ExamplesPage from './pages/ExamplesPage';
import PackagesPage from './pages/PackagesPage';
import ObservabilityPage from './pages/ObservabilityPage';
import LangfusePage from './pages/LangfusePage';
import MemoryPage from './pages/MemoryPage';
import MultiAgentPage from './pages/MultiAgentPage';
import SkillsPage from './pages/SkillsPage';
import McpPage from './pages/McpPage';
import EvalPage from './pages/EvalPage';
import CompressionPage from './pages/CompressionPage';

export default function App() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />
      <Routes>
        <Route
          path="/"
          element={
            <DocsLayout>
              <HomePage />
            </DocsLayout>
          }
        />
        <Route
          path="/quickstart"
          element={
            <DocsLayout>
              <QuickstartPage />
            </DocsLayout>
          }
        />
        <Route
          path="/cli"
          element={
            <DocsLayout>
              <CliPage />
            </DocsLayout>
          }
        />
        <Route
          path="/api"
          element={
            <DocsLayout>
              <ApiPage />
            </DocsLayout>
          }
        />
        <Route
          path="/extend"
          element={
            <DocsLayout>
              <ExtendPage />
            </DocsLayout>
          }
        />
        <Route
          path="/observability"
          element={
            <DocsLayout>
              <ObservabilityPage />
            </DocsLayout>
          }
        />
        <Route
          path="/memory"
          element={
            <DocsLayout>
              <MemoryPage />
            </DocsLayout>
          }
        />
        <Route
          path="/skills"
          element={
            <DocsLayout>
              <SkillsPage />
            </DocsLayout>
          }
        />
        <Route
          path="/mcp"
          element={
            <DocsLayout>
              <McpPage />
            </DocsLayout>
          }
        />
        <Route
          path="/eval"
          element={
            <DocsLayout>
              <EvalPage />
            </DocsLayout>
          }
        />
        <Route
          path="/examples"
          element={
            <DocsLayout>
              <ExamplesPage />
            </DocsLayout>
          }
        />
        <Route
          path="/multi-agent"
          element={
            <DocsLayout>
              <MultiAgentPage />
            </DocsLayout>
          }
        />
        <Route
          path="/compression"
          element={
            <DocsLayout>
              <CompressionPage />
            </DocsLayout>
          }
        />
        <Route
          path="/langfuse"
          element={
            <DocsLayout>
              <LangfusePage />
            </DocsLayout>
          }
        />
        <Route
          path="/packages"
          element={
            <DocsLayout>
              <PackagesPage />
            </DocsLayout>
          }
        />
        <Route
          path="*"
          element={
            <DocsLayout>
              <HomePage />
            </DocsLayout>
          }
        />
      </Routes>
    </div>
  );
}
