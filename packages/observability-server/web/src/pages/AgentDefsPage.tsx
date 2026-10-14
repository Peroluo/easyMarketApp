import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import { api } from '../api';
import { useAuth } from '../auth';
import type { AgentDefinitionItem, AgentSpec } from '../types';

const STATUS_COLOR: Record<AgentDefinitionItem['status'], string> = {
  draft: 'default',
  published: 'green',
  archived: 'gray',
};

const DEFAULT_SPEC: AgentSpec = {
  systemPrompt: '你是一个乐于助人的助手。',
  model: { provider: 'openai', id: 'gpt-4o', temperature: 0.7 },
  tools: [],
  params: { maxTurns: 10 },
};

/** Agent 定义管理：列表 / 新建 / 发布 / 回滚 / 版本 / 删除 */
export default function AgentDefsPage() {
  const { currentProjectId } = useAuth();
  const [agents, setAgents] = useState<AgentDefinitionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [versionsFor, setVersionsFor] = useState<AgentDefinitionItem | null>(null);
  const [versions, setVersions] = useState<AgentDefinitionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [form] = Form.useForm();
  const [editFor, setEditFor] = useState<AgentDefinitionItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm] = Form.useForm();
  const [diffVersion, setDiffVersion] = useState<AgentDefinitionItem | null>(null);

  const load = useCallback(async () => {
    if (!currentProjectId) return;
    setLoading(true);
    try {
      setAgents(await api.listAgents(currentProjectId));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [currentProjectId]);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async (values: { name: string; spec: string }) => {
    if (!currentProjectId) return;
    let spec: AgentSpec;
    try {
      spec = JSON.parse(values.spec) as AgentSpec;
    } catch {
      message.error('Spec 必须是合法 JSON');
      return;
    }
    setCreating(true);
    try {
      await api.createAgent(currentProjectId, values.name, spec);
      message.success('已创建 Agent');
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const onPublish = async (agent: AgentDefinitionItem) => {
    if (!currentProjectId) return;
    try {
      await api.publishAgent(currentProjectId, agent.id);
      message.success('已发布');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onDelete = async (agent: AgentDefinitionItem) => {
    if (!currentProjectId) return;
    try {
      await api.deleteAgent(currentProjectId, agent.id);
      message.success('已删除');
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const openEdit = (agent: AgentDefinitionItem) => {
    setEditFor(agent);
    editForm.setFieldsValue({
      name: agent.name,
      spec: JSON.stringify(agent.spec, null, 2),
    });
    setEditOpen(true);
  };

  const onEdit = async (values: { name: string; spec: string }) => {
    if (!currentProjectId || !editFor) return;
    let spec: AgentSpec;
    try {
      spec = JSON.parse(values.spec) as AgentSpec;
    } catch {
      message.error('Spec 必须是合法 JSON');
      return;
    }
    setEditing(true);
    try {
      await api.updateAgent(currentProjectId, editFor.id, { name: values.name, spec });
      message.success('已更新 Agent');
      setEditOpen(false);
      setEditFor(null);
      await load();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setEditing(false);
    }
  };

  const loadVersions = async (agent: AgentDefinitionItem) => {
    if (!currentProjectId) return;
    setVersionsFor(agent);
    setVersionsLoading(true);
    try {
      setVersions(await api.listAgentVersions(currentProjectId, agent.id));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setVersionsLoading(false);
    }
  };

  const onRollback = async (agent: AgentDefinitionItem, to: string) => {
    if (!currentProjectId) return;
    try {
      await api.rollbackAgent(currentProjectId, agent.id, to);
      message.success(`已回滚到 ${to}`);
      await load();
      if (versionsFor?.id === agent.id) await loadVersions(agent);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '版本',
      dataIndex: 'version',
      width: 80,
      render: (v: number) => <Tag>v{v}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (s: AgentDefinitionItem['status']) => <Tag color={STATUS_COLOR[s]}>{s}</Tag>,
    },
    {
      title: '模型',
      width: 160,
      render: (_: unknown, a: AgentDefinitionItem) => (
        <span className="mono">
          {a.spec?.model?.provider}/{a.spec?.model?.id}
        </span>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      width: 340,
      render: (_: unknown, agent: AgentDefinitionItem) => (
        <Space>
          {agent.status !== 'published' && (
            <Popconfirm
              title="发布 Agent"
              description="发布后该版本可被引用，确认发布？"
              okText="发布"
              onConfirm={() => onPublish(agent)}
            >
              <Button size="small" type="primary" icon={<RocketOutlined />}>
                发布
              </Button>
            </Popconfirm>
          )}
          {agent.status === 'draft' && (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(agent)}>
              编辑
            </Button>
          )}
          <Button size="small" icon={<HistoryOutlined />} onClick={() => loadVersions(agent)}>
            版本
          </Button>
          <Popconfirm
            title="删除 Agent"
            description={`确认删除 ${agent.name}？`}
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(agent)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (!currentProjectId) {
    return (
      <Card>
        <Typography.Text type="secondary">请先在顶部选择一个项目后再管理 Agent 定义。</Typography.Text>
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <span>
            <PlusOutlined /> Agent 定义
          </span>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建 Agent
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={agents}
          columns={columns}
          loading={loading}
          pagination={false}
        />
      </Card>

      <Modal
        title="新建 Agent"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={creating}
        okText="创建"
        width={640}
      >
        <Form
          form={form}
          onFinish={onCreate}
          layout="vertical"
          initialValues={{ name: '', spec: JSON.stringify(DEFAULT_SPEC, null, 2) }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如 customer-support-agent" maxLength={80} />
          </Form.Item>
          <Form.Item
            name="spec"
            label="Spec (JSON)"
            rules={[{ required: true, message: '请输入 Spec' }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 10, maxRows: 20 }}
              className="mono"
              placeholder="AgentSpec JSON"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={versionsFor ? `版本历史 · ${versionsFor.name}` : '版本历史'}
        open={!!versionsFor}
        onCancel={() => setVersionsFor(null)}
        footer={null}
        width={640}
      >
        <Table
          size="small"
          rowKey={(r) => `${r.id}-v${r.version}`}
          dataSource={versions}
          loading={versionsLoading}
          pagination={false}
          columns={[
            {
              title: '版本',
              dataIndex: 'version',
              width: 80,
              render: (v: number) => <Tag>v{v}</Tag>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 110,
              render: (s: AgentDefinitionItem['status']) => (
                <Tag color={STATUS_COLOR[s]}>{s}</Tag>
              ),
            },
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              render: (v: number) => new Date(v).toLocaleString('zh-CN'),
            },
            {
              title: '操作',
              width: 200,
              render: (_: unknown, v: AgentDefinitionItem) => (
                <Space>
                  <Popconfirm
                    title="回滚"
                    description={`确认回滚到 v${v.version}？`}
                    okText="回滚"
                    onConfirm={() => versionsFor && onRollback(versionsFor, String(v.version))}
                  >
                    <Button size="small">回滚</Button>
                  </Popconfirm>
                  <Button size="small" onClick={() => setDiffVersion(v)}>
                    对比
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={editFor ? `编辑 Agent · ${editFor.name}` : '编辑 Agent'}
        open={editOpen}
        onCancel={() => {
          setEditOpen(false);
          setEditFor(null);
        }}
        onOk={() => editForm.submit()}
        confirmLoading={editing}
        okText="保存"
        width={640}
      >
        <Form form={editForm} onFinish={onEdit} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如 customer-support-agent" maxLength={80} />
          </Form.Item>
          <Form.Item
            name="spec"
            label="Spec (JSON)"
            rules={[{ required: true, message: '请输入 Spec' }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 10, maxRows: 20 }}
              className="mono"
              placeholder="AgentSpec JSON"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          versionsFor && diffVersion
            ? `版本对比 · v${diffVersion.version} vs v${versionsFor.version}`
            : '版本对比'
        }
        open={!!diffVersion}
        onCancel={() => setDiffVersion(null)}
        footer={null}
        width={900}
      >
        {versionsFor && diffVersion && (
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text strong>v{diffVersion.version}（历史版本）</Typography.Text>
              <pre
                style={{
                  background: '#f5f5f5',
                  padding: 12,
                  borderRadius: 4,
                  margin: '8px 0 0',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 480,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(diffVersion.spec, null, 2)}
              </pre>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text strong>v{versionsFor.version}（当前版本）</Typography.Text>
              <pre
                style={{
                  background: '#f5f5f5',
                  padding: 12,
                  borderRadius: 4,
                  margin: '8px 0 0',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 480,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(versionsFor.spec, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </Space>
  );
}
