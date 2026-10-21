export interface ApiParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface ApiItem {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type';
  signature: string;
  description: string;
  params?: ApiParam[];
  returns?: string;
  example?: string;
  category: string;
}

export const apiList: ApiItem[] = [
  // ========== Runtime 核心 ==========
  {
    id: 'createRuntime',
    name: 'createRuntime()',
    kind: 'function',
    signature: 'createRuntime(options?: RuntimeOptions): Runtime',
    description: '创建一个 Agent Runtime 实例。Runtime 是整个 Agent 系统的核心调度器，负责接收请求、构建任务图、链式转换上下文、调用模型、执行工具、产出结果。',
    category: 'Runtime 核心',
    params: [
      { name: 'options.config', type: 'Record<string, unknown>', description: '运行时配置对象，可被 Extension 读取' },
      { name: 'options.workspace', type: 'string', description: '工作区路径，用于日志、记忆、AI 上下文基目录' },
      { name: 'options.systemPrompt', type: 'string', description: '系统提示词，定义 AI 助手的角色与行为' },
      { name: 'options.model', type: 'Model', description: '模型配置（id/name/provider/contextWindow 等），需配合 adaptAiModel 使用' },
      { name: 'options.streamFn', type: 'StreamFn', description: '模型流式函数（模型提供者），若使用 AI 层可通过 createStreamFnFromAi 生成' },
      { name: 'options.tools', type: 'Tool[]', description: '初始工具列表，可在运行时通过 registerTool 追加' },
      { name: 'options.extensions', type: 'Extension[]', description: '预注册的扩展插件列表' },
      { name: 'options.transformers', type: 'ContextTransformer[]', description: '预注册的上下文转换器，按数组顺序链式执行（上一个输出作为下一个输入）' },
      { name: 'options.sessionStorage', type: 'SessionStorage', description: '会话存储适配器，启用后会话自动持久化' },
      { name: 'options.maxSessions', type: 'number', description: '内存会话上限，超限按 LRU 淘汰最久未用会话（默认 256）。仅影响内存态，持久化会话不受影响' },
      { name: 'options.permissionPolicy', type: 'PermissionPolicy', description: '框架级工具权限策略（可选）。未配置时全部放行（向后兼容），生产环境建议配置；deny 产出 details.blocked 结果、不终止 run，模型可换策略。check 可返回 pending 走异步审批通道（需配置 approvals）' },
      { name: 'options.approvals', type: 'ApprovalManager', description: '审批管理器（Human-in-the-loop，可选）。permissionPolicy 返回 pending 时，Runtime 挂起工具调用并创建审批单，外部任意时机 resolve(id, true/false) 恢复执行；未配置时 pending 视为 deny。由 createApprovalManager 创建' },
      { name: 'options.approvalTimeoutMs', type: 'number', description: '审批等待超时毫秒数（默认 300000 = 5 分钟）。超时审批单以 timeout 结算，对应工具调用被拒绝（保守）' },
      { name: 'options.telemetry', type: 'Telemetry', description: '轻量可观测：onRunEnd / onToolCall / onModelCall / onRetry / onCompaction 等，全可选、上报失败不影响主流程' },
      { name: 'options.maxTurns', type: 'number', description: '单次请求最大对话回合数，默认 50，防止失控循环' },
      { name: 'options.toolTimeoutMs', type: 'number', description: '单个工具执行超时（毫秒），默认 120000' },
      { name: 'options.parallelToolCalls', type: 'boolean', description: '是否并行执行同一轮的多个工具调用，默认 true' },
      { name: 'options.thinkingLevel', type: 'ThinkingLevel', description: '思考/推理级别，默认 off，仅对 reasoning 模型生效' },
      { name: 'options.maxResources', type: 'number', description: '上下文资源条数上限，默认 200（TruncationTransformer）' },
      { name: 'options.contextBudgetRatio', type: 'number', description: 'token 预算占 contextWindow 的比例，默认 0.8' },
      { name: 'options.compaction', type: 'CompactionOptions', description: '内置摘要压缩（可选）：token 超阈值时 LLM 摘要旧历史替换为 compactionSummary 消息，失败降级硬截断；未配置保持旧行为。详见 CompactionOptions 条目' },
    ],
    returns: 'Runtime 实例，可调用 run/stream/registerTool 等方法',
    example: `import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from '@aipack-ai/agent';

const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');

const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  systemPrompt: '你是一个简洁的 AI 助手',
  sessionStorage: createFileSessionStorage({ baseDir: './sessions' }),
  maxTurns: 20,
});

const result = await runtime.run(createRequest('你好'));
console.log(result.content);
await runtime.close();`,
  },
  {
    id: 'Runtime-run',
    name: 'runtime.run()',
    kind: 'function',
    signature: 'run(request: Request): Promise<Result>',
    description: '同步执行请求，一次性返回完整结果。内部会自动处理多轮工具调用循环，直到模型不再输出工具调用或达到 maxTurns 上限。',
    category: 'Runtime 核心',
    params: [
      { name: 'request', type: 'Request', required: true, description: '通过 createRequest 构建的请求对象' },
    ],
    returns: 'Promise<Result> - 运行结果，包含 content、toolsUsed、usage、stopReason 等字段',
    example: `const result = await runtime.run(
  createRequest('解释什么是闭包')
);
console.log(result.content);  // 最终回复文本
console.log(result.toolsUsed); // 调用过的工具名列表
console.log(result.usage);    // Token 用量统计`,
  },
  {
    id: 'Runtime-stream',
    name: 'runtime.stream()',
    kind: 'function',
    signature: 'stream(request: Request): AsyncGenerator<ResultChunk>',
    description: '流式执行请求，逐块返回增量事件。支持文本 delta、思考 delta、工具调用开始/结束等事件类型，适合实现打字机效果或实时状态展示。',
    category: 'Runtime 核心',
    params: [
      { name: 'request', type: 'Request', required: true, description: '通过 createRequest 构建的请求对象' },
    ],
    returns: 'AsyncGenerator<ResultChunk> - 异步生成器，yield 各种类型的增量 chunk',
    example: `for await (const chunk of runtime.stream(
  createRequest('写一首关于秋天的诗')
)) {
  switch (chunk.type) {
    case 'text':
      process.stdout.write(chunk.content ?? '');  // 文本增量
      break;
    case 'thinking':
      // 思考过程增量（reasoning 模型）
      break;
    case 'tool_start':
      console.log(\`\\n[工具开始] \${chunk.toolName}\`);
      break;
    case 'tool_end':
      console.log(\`\\n[工具结束] \${chunk.toolName}\`);
      break;
    case 'done':
      console.log('\\n[完成]');
      break;
    case 'error':
      console.error('错误:', chunk.error);
      break;
  }
}`,
  },
  {
    id: 'Runtime-registerTool',
    name: 'runtime.registerTool()',
    kind: 'function',
    signature: 'registerTool(tool: Tool): this',
    description: '在运行时动态注册单个工具。注册后工具立即可被下一次 run/stream 调用。支持链式调用。',
    category: 'Runtime 核心',
    params: [
      { name: 'tool', type: 'Tool', required: true, description: '工具定义，包含 name、description、parameters、execute 等字段' },
    ],
    returns: 'this - Runtime 实例，支持链式调用',
    example: `runtime.registerTool({
  name: 'get_weather',
  description: '查询指定城市的当前天气',
  parameters: Type.Object({
    city: Type.String({ description: '城市名称' }),
  }),
  execute: async (id, args) => ({
    content: [{ type: 'text', text: \`\${args.city}: 晴，25°C\` }],
    details: {},
  }),
});`,
  },
  {
    id: 'Runtime-session',
    name: '会话管理方法（多会话）',
    kind: 'function',
    signature: 'getMessages(sessionKey?) / clearSession(sessionKey?) / deleteSession(sessionKey?) / abort(sessionKey?) / isBusy(sessionKey?) / waitForIdle(sessionKey?) / hasSession(key) / getSessionKeys()',
    description: '同一 Runtime 可服务多个会话：请求携带 sessionKey 时按 key 路由到独立会话（消息历史、串行队列、abort/busy 状态互相隔离），未携带则使用默认会话。所有会话方法均可选传 sessionKey 定位到具体会话。配置了 sessionStorage 时，会话操作同时作用于内存和持久化存储（存储级加锁保证多进程安全）。',
    category: 'Runtime 核心',
    example: `// 多会话：同一 Runtime 服务 user-1 和 user-2，历史互相隔离
await runtime.run(createRequest('你好', { sessionKey: 'user-1' }));
await runtime.run(createRequest('你好', { sessionKey: 'user-2' }));

// 按会话读取消息 / 状态
const msgs1 = runtime.getMessages('user-1');
const busy2 = runtime.isBusy('user-2');

// 中止 / 删除指定会话
runtime.abort('user-1');
const deleted = await runtime.deleteSession('user-2');

// 当前活跃会话列表
console.log(runtime.getSessionKeys());

// 更便捷的多租户门面：SessionManager（见"多会话"分类）
const sm = createSessionManager({ runtimeOptions: { model, streamFn } });
await sm.run('你好', 'user-3');`,
  },

  // ========== Request 请求 ==========
  {
    id: 'createRequest',
    name: 'createRequest()',
    kind: 'function',
    signature: 'createRequest(message: string, options?: RequestOptions): Request',
    description: '构建一个请求对象，是 run/stream 的入口参数。最简单的用法只需传入消息文本。通过 options.sessionKey 可路由到指定会话（多会话/多租户），未指定时使用 Runtime 默认会话；高级用法可指定 channel、metadata、ephemeral 等。',
    category: 'Request 请求',
    params: [
      { name: 'message', type: 'string', required: true, description: '用户输入的消息文本' },
      { name: 'options.sessionKey', type: 'string', description: '会话标识。同一 Runtime 服务多会话时按此 key 路由（历史隔离 + 串行队列独立），未指定回退 Runtime 默认会话' },
      { name: 'options.channel', type: 'string', description: '来源渠道标识，如 "web"、"cli"、"vscode"' },
      { name: 'options.chatId', type: 'string', description: '聊天 ID，用于关联多条消息' },
      { name: 'options.senderId', type: 'string', description: '发送者 ID，区分不同用户' },
      { name: 'options.ephemeral', type: 'boolean', description: '临时会话：不持久化到 sessionStorage' },
      { name: 'options.metadata', type: 'Record<string, unknown>', description: '附加元数据，Extension 可读取' },
    ],
    returns: '标准化的 Request 对象',
    example: `// 最简单的一次性请求
const req1 = createRequest('你好');

// 带元数据的请求（Extension 中可通过 request.metadata 读取）
const req2 = createRequest('生成报告', {
  channel: 'web-dashboard',
  metadata: { userId: 'u-001', priority: 'high' },
});

// 多轮对话：同一会话 key 的多次 run 自动关联历史
await runtime.run(createRequest('记住我叫张三', { sessionKey: 'sess-1' }));
await runtime.run(createRequest('我叫什么？', { sessionKey: 'sess-1' }));

// 不同会话 key 的历史互相隔离（多租户）
await runtime.run(createRequest('你好', { sessionKey: 'user-b' }));`,
  },
  {
    id: 'RequestBuilder',
    name: 'RequestBuilder',
    kind: 'class',
    signature: 'new RequestBuilder().message(text).channel(ch)...build()',
    description: '链式请求构建器，适合需要逐步组装请求的场景。每个方法返回 this，最后调用 build() 生成 Request 对象。',
    category: 'Request 请求',
    example: `import { RequestBuilder } from '@aipack-ai/agent';

const request = new RequestBuilder()
  .message('帮我分析这段代码')
  .channel('vscode')
  .senderId('dev-alice')
  .metadata('file', 'src/index.ts')
  .metadata('lineStart', 100)
  .build();

await runtime.run(request);`,
  },

  // ========== Session 会话 ==========
  {
    id: 'createFileSessionStorage',
    name: 'createFileSessionStorage()',
    kind: 'function',
    signature: 'createFileSessionStorage(options?: FileSessionStorageOptions): SessionStorage',
    description: '创建文件系统会话存储适配器。每个会话以独立 JSON 文件保存（默认目录 <pwd>/.aipack/sessions），采用 temp + rename 原子写入防止损坏。支持 maxAge 过期惰性清理与 maxStoredMessages 条数上限。',
    category: 'Session 会话',
    params: [
      { name: 'options.baseDir', type: 'string', description: '会话存储根目录，默认 <pwd>/.aipack/sessions' },
      { name: 'options.maxAge', type: 'number', description: '会话最大存活时间（毫秒），超过后在加载时惰性清理。如 30 天 = 30 * 24 * 60 * 60 * 1000' },
      { name: 'options.maxStoredMessages', type: 'number', description: '持久化消息条数上限（保留最新 N 条，0 表示不限，默认 0）' },
    ],
    returns: 'SessionStorage 实例，可传给 createRuntime 的 sessionStorage 选项',
    example: `import { createFileSessionStorage } from '@aipack-ai/agent';

// 会话持久化到磁盘，30 天后自动清理，最多保留 200 条消息
const storage = createFileSessionStorage({
  baseDir: './data/sessions',
  maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 天（毫秒）
  maxStoredMessages: 200,
});

const runtime = createRuntime({
  // ... model/streamFn
  sessionStorage: storage,
});`,
  },
  {
    id: 'createMemorySessionStorage',
    name: 'createMemorySessionStorage()',
    kind: 'function',
    signature: 'createMemorySessionStorage(options?: MemorySessionStorageOptions): SessionStorage',
    description: '创建内存会话存储适配器。会话仅保存在内存中，进程退出即丢失。适合测试或不需要持久化的临时场景。',
    category: 'Session 会话',
    params: [
      { name: 'options.maxAge', type: 'number', description: '会话最大存活时间（毫秒），超期自动清理' },
    ],
    example: `import { createMemorySessionStorage } from '@aipack-ai/agent';

const storage = createMemorySessionStorage({
  maxAge: 2 * 60 * 60 * 1000,  // 2 小时
});`,
  },
  {
    id: 'createFileSessionStorage-lock',
    name: 'FileSessionStorage 存储级锁',
    kind: 'type',
    signature: 'createFileSessionStorage({ lockWaitMs?, lockStaleMs?, lockRetryMs? })  ·  storage.withLock(key, fn)',
    description: '文件会话存储支持存储级锁（O_EXCL 锁文件 + 陈旧锁回收 + 指数退避 jitter），保证多进程/多实例对同一会话的读写互斥。Runtime 的 run/stream/deleteSession 默认开启会话级加锁。',
    category: 'Session 会话',
    params: [
      { name: 'options.lockWaitMs', type: 'number', description: '获取锁的最大等待时间（默认 30000ms），超时抛错' },
      { name: 'options.lockStaleMs', type: 'number', description: '锁视为陈旧的阈值（默认 300000ms），超时自动回收（进程崩溃恢复）' },
      { name: 'options.lockRetryMs', type: 'number', description: '重试间隔（默认 25ms，指数退避至 500ms + jitter）' },
    ],
    example: `import { createFileSessionStorage } from '@aipack-ai/agent';

const storage = createFileSessionStorage({
  baseDir: './sessions',
  lockWaitMs: 5000,    // 最多等 5s
  lockStaleMs: 30000,  // 30s 未续期视为陈旧，可回收
});

// 手动持锁执行临界区（Runtime 内部已自动加锁，通常无需手动）
await storage.withLock('user-1', async () => {
  // 多进程互斥的读写区
});`,
  },

  // ========== 多会话 ==========
  {
    id: 'createSessionManager',
    name: 'createSessionManager()',
    kind: 'function',
    signature: 'createSessionManager(options?: SessionManagerOptions): SessionManager',
    description: '创建多会话管理器门面。让多个会话共享同一个 Runtime 实例（模型/工具/扩展/转换器等资源跨会话共享），每个会话按 sessionKey 拥有独立的消息历史、串行队列与 abort/busy 状态。底层由 Runtime 内建多会话路由（request.sessionKey）实现。',
    category: '多会话',
    params: [
      { name: 'options.runtime', type: 'Runtime', description: '复用已有 Runtime 实例' },
      { name: 'options.runtimeOptions', type: 'RuntimeOptions', description: '未提供 runtime 时据此创建共享 Runtime' },
    ],
    returns: 'SessionManager 实例',
    example: `import { createSessionManager, getBuiltinModel, adaptAiModel, createStreamFnFromAi } from '@aipack-ai/agent';

const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');

const sm = createSessionManager({
  runtimeOptions: {
    model: adaptAiModel(aiModel),
    streamFn: createStreamFnFromAi(aiModel),
    sessionStorage: createFileSessionStorage({ baseDir: './sessions' }),
  },
});

// 两个会话共享同一 Runtime，历史互相隔离、串行执行
await sm.run('记住我叫张三', 'user-1');
await sm.run('你好', 'user-2');

const r = await sm.run('我叫什么？', 'user-1');  // 知道"张三"
console.log(r.content);

sm.abort('user-1');           // 只中止 user-1
const keys = sm.listSessions(); // ['user-1', 'user-2']
await sm.close();`,
  },
  {
    id: 'SessionManager',
    name: 'SessionManager 类',
    kind: 'class',
    signature: 'run(msg, key?) / stream(msg, key?) / getMessages(key?) / abort(key?) / isBusy(key?) / waitForIdle(key?) / clearSession(key?) / deleteSession(key?) / hasSession(key) / listSessions()',
    description: '多会话管理器的实例方法。所有方法均可选传 sessionKey 定位到具体会话，未传则作用于默认会话。是 Runtime 多会话能力（request.sessionKey 路由）之上的多租户便捷门面。',
    category: '多会话',
    example: `const sm = createSessionManager({ runtime });

// 流式运行指定会话
for await (const chunk of sm.stream('写首诗', 'user-9')) {
  if (chunk.type === 'text') process.stdout.write(chunk.content ?? '');
}

// 查询状态
const busy = sm.isBusy('user-9');
const history = sm.getMessages('user-9');
await sm.waitForIdle('user-9');

// 清理
sm.clearSession('user-9');                  // 仅内存
await sm.deleteSession('user-9');           // 内存 + 存储`,
  },

  // ========== 权限安全 ==========
  {
    id: 'createPermissionPolicy',
    name: 'createPermissionPolicy()',
    kind: 'function',
    signature: 'createPermissionPolicy(options: { rules, defaultDecision? }): PermissionPolicy',
    description: '创建规则型工具权限策略。规则按顺序匹配，命中即采用该决策（allow/deny/confirm/pending）；无规则匹配时默认 deny（deny-by-default）。confirm 为内联人工确认（confirmFn 在当前调用内返回，未提供视为 deny，适合交互式 CLI）；pending 走异步审批单通道（需 RuntimeOptions.approvals，适合 Web / 长任务 / 远程审批）。配合 Tool.permissions 能力声明使用，是框架级安全底线。',
    category: '权限安全',
    params: [
      { name: 'options.rules', type: 'PermissionRule[]', required: true, description: '规则列表：name / toolName(正则) / permission(前缀匹配) / matchArgs(参数谓词) / decision' },
      { name: 'options.confirmFn', type: '(req: PermissionRequest) => Promise<boolean>', description: 'confirm 决策时的人工确认回调（返回 true 放行本次）；未提供则 confirm 视为 deny' },
      { name: 'options.defaultDecision', type: 'PermissionDecision', description: '无规则命中时的决策，默认 deny' },
    ],
    returns: 'PermissionPolicy 实例，传入 createRuntime 的 permissionPolicy 选项',
    example: `import {
  createPermissionPolicy,
  createRuntime,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from '@aipack-ai/agent';

const policy = createPermissionPolicy({
  rules: [
    // 允许只读 shell 命令
    { name: 'readonly-shell', toolName: /^run_command$/, permission: 'shell:exec',
      matchArgs: (a) => /^(ls|git status|cat|head|tail)\\b/.test(String((a as any).command ?? '')),
      decision: 'allow' },
    // 文件写入需人工确认
    { name: 'write-confirm', permission: 'fs:write', decision: 'confirm' },
    // 其余一律 deny
  ],
  defaultDecision: 'deny',
  // confirm 决策默认拒绝；提供 confirmFn 后接交互层（返回 true 放行本次）
  confirmFn: async (req) => showConfirmDialog(req.toolName, req.args),
});

const runtime = createRuntime({
  model: adaptAiModel(getBuiltinModel('deepseek', 'deepseek-chat')),
  streamFn: createStreamFnFromAi(getBuiltinModel('deepseek', 'deepseek-chat')),
  permissionPolicy: policy,
});

// 未被规则放行的工具调用将返回 details.blocked 结果，run 不中断
const result = await runtime.run(createRequest('帮我执行 ls'));`,
  },
  {
    id: 'createAllowListPolicy',
    name: 'createAllowListPolicy()',
    kind: 'function',
    signature: 'createAllowListPolicy(options: { allow: readonly string[]; confirmFn?: (req) => Promise<boolean> }): PermissionPolicy',
    description: '创建白名单策略：列表中的工具名直接放行，其余一律拒绝。可选 confirmFn 把未命中的工具转为人工确认（返回 true 放行本次、false 拒绝）。注意 allow 按工具名精确匹配（而非权限能力）。',
    category: '权限安全',
    params: [
      { name: 'options.allow', type: 'string[]', required: true, description: '放行的工具名列表，如 ["read_file", "grep", "glob"]' },
      { name: 'options.confirmFn', type: '(req: PermissionRequest) => Promise<boolean>', description: '可选：未命中白名单时的人工确认回调。提供后未命中项为 confirm（返回 true 放行），未提供则直接 deny' },
    ],
    returns: 'PermissionPolicy 实例',
    example: `import { createAllowListPolicy } from '@aipack-ai/agent';

// 只放行只读文件工具，其余一律拒绝；写入类工具走人工确认
const policy = createAllowListPolicy({
  allow: ['read_file', 'grep', 'glob', 'list_directory'],
  confirmFn: async (req) => {
    console.log('需确认工具:', req.toolName, req.args);
    return confirmDialog(req); // 返回 true 放行本次
  },
});`,
  },
  {
    id: 'createDenyAllPolicy',
    name: 'createDenyAllPolicy()',
    kind: 'function',
    signature: 'createDenyAllPolicy(): PermissionPolicy',
    description: '创建全拒绝策略：所有工具调用一律拒绝（安全演示、只读评估、沙箱隔离场景）。',
    category: '权限安全',
    example: `import { createDenyAllPolicy, createRuntime } from '@aipack-ai/agent';

// 只读评估环境：禁止一切工具
const runtime = createRuntime({
  // ...model / streamFn
  permissionPolicy: createDenyAllPolicy(),
});`,
  },
  {
    id: 'createApprovalManager',
    name: 'createApprovalManager()',
    kind: 'function',
    signature: 'createApprovalManager(options?: { store?: ApprovalStore }): ApprovalManager',
    description: '创建审批管理器：pending 决策的审批单生命周期管理。解耦关键——发起 run 的调用栈与批准人之间以审批单 id 通信，Runtime 挂起等待 wait()，外部任意时机调 resolve()，两者无需共享调用栈（Web / 桌面端 / 长任务审批场景）。配置 store 后审批单持久化，进程重启可经 restore() 恢复未决列表（恢复的是"孤儿"审批单：可批准/驳回且结果落审计，但原 run 已丢失）。方法：create / wait / list / resolve / cancel / restore / close / onPending / onSettled。',
    category: '权限安全',
    params: [
      { name: 'options.store', type: 'ApprovalStore', description: '可选持久化存储（FileApprovalStore / MemoryApprovalStore）。create 落盘、结算清理 + 审计（fire-and-forget，失败仅警告）；未配置时纯内存（进程内有效）' },
    ],
    returns: 'ApprovalManager 实例，传入 createRuntime 的 approvals 选项',
    example: `import {
  createRuntime,
  createRequest,
  createApprovalManager,
  FileApprovalStore,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from '@aipack-ai/agent';

// 配置持久化：审批单落盘，进程重启后 restore() 恢复
const approvals = createApprovalManager({
  store: new FileApprovalStore({ baseDir: '~/.aipack/approvals' }),
});
await approvals.restore(); // 恢复重启遗留的孤儿审批单（触发 onPending）

const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');
const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
  approvals,                       // 启用异步审批通道
  approvalTimeoutMs: 5 * 60_000,   // 等待超时：视为拒绝（保守）
  permissionPolicy: {
    async check(req) {
      // 部署工具挂起等待人工批准，其余放行
      return req.toolName === 'deploy' ? 'pending' : 'allow';
    },
  },
});

// UI / 遥测侧：感知新审批单并处理（与发起 run 的调用栈解耦）
approvals.onPending((a) => {
  console.log('待审批:', a.request.toolName, a.request.args);
  // 展示审批卡片，人工点击后：
  // approvals.resolve(a.id, true);  // 或 false 驳回
});
approvals.onSettled((o) => {
  console.log('结算:', o.status, '等待 ' + o.waitedMs + 'ms');
});

// 发起 run：deploy 工具调用会挂起，直到 resolve / 超时 / abort
const result = await runtime.run(createRequest('执行部署'));

// 优雅退出：未决审批单保留在存储中，下次启动 restore() 继续
process.on('SIGINT', () => approvals.close());`,
  },
  {
    id: 'FileApprovalStore',
    name: 'FileApprovalStore',
    kind: 'class',
    signature: 'new FileApprovalStore(options?: { baseDir?: string })',
    description: '审批单文件持久化存储（默认 ~/.aipack/approvals/，与 sessions 平级）。布局：<id>.json 未决审批单（temp + rename 原子写，结算即删除）、history.jsonl 结算审计（追加写，含 status / waitedMs / reason）、.corrupt 损坏隔离（load 时改名保留现场）。load 按创建时间升序返回。MemoryApprovalStore 为内存实现（测试 / 嵌入式）。',
    category: '权限安全',
    params: [
      { name: 'options.baseDir', type: 'string', description: '审批单目录（默认 ~/.aipack/approvals）' },
    ],
    example: `import { FileApprovalStore, createApprovalManager } from '@aipack-ai/agent';

const store = new FileApprovalStore({ baseDir: './data/approvals' });
const approvals = createApprovalManager({ store });

// CLI 场景等价物：aipack.config.js 中 approvals: { enabled: true, baseDir: ... }
// 命令：aipack approvals list / approve <id> / deny <id>`,
  },
  {
    id: 'hasPermission',
    name: 'hasPermission()',
    kind: 'function',
    signature: 'hasPermission(permissions: readonly string[], target: string): boolean',
    description: '判断工具声明的能力列表中是否包含目标能力。支持精确匹配（fs:write）与前缀匹配（target 为 "shell" 时命中 "shell:exec"）。用于编写自定义策略/校验器。',
    category: '权限安全',
    params: [
      { name: 'permissions', type: 'string[]', required: true, description: '工具声明的能力列表（Tool.permissions）' },
      { name: 'target', type: 'string', required: true, description: '要检查的能力，如 "fs:write"；以冒号结尾（如 "fs:"）或裸前缀（"shell"）表示前缀匹配' },
    ],
    returns: 'boolean - 是否包含目标能力',
    example: `import { hasPermission } from '@aipack-ai/agent';

const tool = {
  name: 'write_file',
  permissions: ['fs:write'],
  // ...
};

hasPermission(tool.permissions, 'fs:write'); // true
hasPermission(tool.permissions, 'fs');       // true（前缀匹配）
hasPermission(tool.permissions, 'fs:read');  // false`,
  },
  {
    id: 'Tool-permissions',
    name: 'Tool.permissions 能力声明',
    kind: 'type',
    signature: 'Tool { permissions?: string[] }',
    description: '工具声明自身需要的权限能力（如 shell:exec / fs:write / fs:read / memory:write / network:fetch），供框架级 PermissionPolicy 裁决。未声明视为安全工具（permissions: []）。',
    category: '权限安全',
    example: `import { Type } from '@aipack-ai/agent/ai';
import type { Tool } from '@aipack-ai/agent';

const tool: Tool = {
  name: 'send_mail',
  description: '发送邮件',
  parameters: Type.Object({ to: Type.String() }),
  permissions: ['network:fetch', 'fs:read'],  // 声明所需能力
  execute: async (id, args) => ({ content: [{ type: 'text', text: 'sent' }], details: {} }),
};`,
  },

  // ========== AI 模型层 ==========
  {
    id: 'getBuiltinModel',
    name: 'getBuiltinModel()',
    kind: 'function',
    signature: 'getBuiltinModel(providerId: string, modelId: string): Model',
    description: '从内置模型目录获取标准化的 AI 模型对象。内置支持 DeepSeek、OpenAI、Anthropic、Google、Mistral、Bedrock 等多个提供商，返回的 Model 可直接传给 adaptAiModel + createStreamFnFromAi。',
    category: 'AI 模型层',
    params: [
      { name: 'providerId', type: 'string', required: true, description: '提供商 ID，如 deepseek / openai / anthropic' },
      { name: 'modelId', type: 'string', required: true, description: '模型 ID，如 deepseek-chat / gpt-4o-mini / claude-3-5-sonnet' },
    ],
    returns: '标准化 AiModel 对象（aipack/ai 的 Model 类型）',
    example: `import { getBuiltinModel } from '@aipack-ai/agent';

// 获取 DeepSeek 模型
const deepseek = getBuiltinModel('deepseek', 'deepseek-chat');

// 获取 OpenAI 模型
const gpt = getBuiltinModel('openai', 'gpt-4o-mini');

// API Key 通过环境变量自动读取（如 DEEPSEEK_API_KEY、OPENAI_API_KEY）`,
  },
  {
    id: 'adaptAiModel',
    name: 'adaptAiModel()',
    kind: 'function',
    signature: 'adaptAiModel(aiModel: AiModel): Model',
    description: 'AI 层适配器：将 aipack/ai 的标准化 Model 转换为框架核心需要的 Model 类型。两者字段高度相似，此函数做类型桥接与字段兼容。',
    category: 'AI 模型层',
    params: [
      { name: 'aiModel', type: 'AiModel', required: true, description: '通过 getBuiltinModel 或自定义获取的 AI 模型' },
    ],
    returns: 'Runtime 可用的 core Model 类型',
    example: `const aiModel = getBuiltinModel('deepseek', 'deepseek-chat');

// 适配后传给 createRuntime
const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel),
});`,
  },
  {
    id: 'createStreamFnFromAi',
    name: 'createStreamFnFromAi()',
    kind: 'function',
    signature: 'createStreamFnFromAi(aiModel: AiModel, options?): StreamFn',
    description: 'AI 层适配器：根据模型 api 字段自动分派到对应的流式实现（streamOpenAI / streamAnthropic 等），并将事件转换为 Runtime 需要的 StreamEvent 格式。是连接模型层与 Runtime 的桥梁。',
    category: 'AI 模型层',
    params: [
      { name: 'aiModel', type: 'AiModel', required: true, description: 'AI 模型对象' },
      { name: 'options', type: 'SimpleStreamOptions', description: '透传给底层流式实现的选项：apiKey / credentials(注入的凭证存储) / headers / baseUrl(经模型) / temperature / maxTokens / reasoning / idleTimeoutMs / timeoutMs 等' },
    ],
    returns: 'Runtime 可用的 StreamFn，可直接传入 createRuntime',
    example: `import {
  createRuntime,
  getBuiltinModel,
  adaptAiModel,
  createStreamFnFromAi,
} from '@aipack-ai/agent';

const aiModel = getBuiltinModel('openai', 'gpt-4o-mini');

const runtime = createRuntime({
  model: adaptAiModel(aiModel),
  streamFn: createStreamFnFromAi(aiModel, {
    temperature: 0.7,
    maxTokens: 2048,
    idleTimeoutMs: 120_000,   // 120s 无数据视为断流
  }),
});`,
  },
  {
    id: 'getEnvApiKey',
    name: 'getEnvApiKey()',
    kind: 'function',
    signature: 'getEnvApiKey(providerId: string): string | undefined',
    description: '从环境变量读取指定提供商的 API Key。变量名统一为约定名 <PROVIDER_ID_UPPERCASE>_API_KEY（如 deepseek → DEEPSEEK_API_KEY、google → GOOGLE_API_KEY），与 CredentialStore / resolveApiKey 解析完全一致。',
    category: 'AI 模型层',
    params: [
      { name: 'providerId', type: 'string', required: true, description: '提供商 ID' },
    ],
    returns: 'API Key 字符串，未配置则返回 undefined',
    example: `import { getEnvApiKey, hasProviderConfigured } from '@aipack-ai/agent';

const key = getEnvApiKey('deepseek');
console.log('Key 已配置:', !!key);

console.log('DeepSeek 可用:', hasProviderConfigured('deepseek'));
console.log('OpenAI 可用:', hasProviderConfigured('openai'));
console.log('Google 可用:', hasProviderConfigured('google')); // 读 GOOGLE_API_KEY`,
  },
  {
    id: 'CredentialStore',
    name: 'CredentialStore 凭证存储',
    kind: 'interface',
    signature: 'interface CredentialStore { read(providerId) / list() / modify() / delete() }  ·  EnvCredentialStore / createEnvCredentialStore()',
    description: 'API Key 凭证存储抽象：默认 EnvCredentialStore（读环境变量约定名），可注入 KMS / Vault 等自定义实现。createModels({ credentials }) 注入后，实际请求即使用该存储解析的 Key；getAuth() 与 resolveApiKey 遵循同一优先级：注入的 store → 环境变量 → 自定义 auth 解析器。注意：本条目属于 AI 深层 surface，需从子路径 @aipack-ai/agent/ai 导入（主入口 @aipack-ai/agent 不导出）。',
    category: 'AI 模型层',
    params: [
      { name: 'createEnvCredentialStore()', type: '() => CredentialStore', description: '默认实现：按约定名 <PROVIDER>_API_KEY 读取 process.env' },
      { name: 'read(providerId)', type: '(id) => Promise<unknown>', description: '读取某 provider 的凭证，返回 string 视为 API Key' },
    ],
    example: `import { createModels, createEnvCredentialStore } from '@aipack-ai/agent/ai';

// 默认：EnvCredentialStore（无需配置）
const models = createModels();

// 注入自定义凭证存储（KMS / Vault），实际请求将使用该 Key
class KmsStore {
  async read(providerId) { return vault.fetchSecret(providerId + '_api_key'); }
  async list() { return []; }
  async modify() {}
  async delete() {}
}
const models2 = createModels({ credentials: new KmsStore() });

// 认证查询：与 resolveApiKey 同一优先级
const auth = await models2.getAuth('deepseek');
console.log(auth?.source); // 'credential-store' | env 变量名`,
  },

  // ========== Extension 扩展 ==========
  {
    id: 'createToolHookExtension',
    name: 'createToolHookExtension()',
    kind: 'function',
    signature: 'createToolHookExtension(options: {...}): Extension',
    description: '工具钩子扩展工厂：以声明式对象 API 注册 beforeToolCall / afterToolCall 回调。beforeToolCall 可拦截工具执行（block）、终止整个 run（terminate）或改写参数；afterToolCall 可改写结果或终止。',
    category: 'Extension 扩展',
    params: [
      { name: 'options.name', type: 'string', description: '扩展名称，默认 tool-hooks' },
      { name: 'options.beforeToolCall', type: '(ctx: ToolCallContext) => BeforeToolCallResult', description: '工具执行前回调。可返回 block:true 阻止执行、terminate:true 终止 run、args 覆盖参数' },
      { name: 'options.afterToolCall', type: '(ctx: AfterToolCallContext) => AfterToolCallResult', description: '工具执行后回调。可 terminate 终止、result 替换结果、details 合并元数据' },
    ],
    returns: 'Extension 实例，可传给 createRuntime 或 runtime.registerExtension',
    example: `import { createToolHookExtension } from '@aipack-ai/agent';

const guard = createToolHookExtension({
  name: 'safety-guard',
  beforeToolCall: async (ctx) => {
    // 示例：禁止在生产环境执行危险命令
    if (ctx.tool.name === 'run_command') {
      const cmd = String(ctx.args ?? '');
      if (cmd.includes('drop table') || cmd.includes('rm -rf')) {
        return { block: true, reason: '命令被安全策略拦截' };
      }
    }
    // 示例：审计日志
    console.log(\`[\${ctx.sessionKey}] 调用工具 \${ctx.toolName}\`, ctx.args);
  },
  afterToolCall: async (ctx) => {
    if (ctx.isError) {
      // 错误上报
      reportError(ctx.result.details?.error);
      // 可选：terminate 整个 run
      // return { terminate: true };
    }
    // 合并追踪信息
    return { details: { traceId: genTraceId() } };
  },
});

const runtime = createRuntime({
  // ...model/streamFn
  extensions: [guard],
});`,
  },
  {
    id: 'BuiltinExtensions',
    name: '内置扩展',
    kind: 'class',
    signature: 'LoggingExtension / EventCaptureExtension / SharedStateExtension / ...',
    description: '框架内置多种通用扩展：LoggingExtension 日志输出、EventCaptureExtension 事件捕获（调试/监控）、RequestInterceptorExtension 请求拦截、ResultPostProcessorExtension 结果后处理、SharedStateExtension 扩展间共享状态。',
    category: 'Extension 扩展',
    example: `import {
  LoggingExtension,
  EventCaptureExtension,
  RequestInterceptorExtension,
  SharedStateExtension,
  createDefaultExtensions,
} from '@aipack-ai/agent';

// 方式一：用 createDefaultExtensions 获取推荐默认值
const defaults = createDefaultExtensions({ verbose: true });

// 方式二：手动组合
const runtime = createRuntime({
  extensions: [
    new LoggingExtension(true),  // verbose 日志
    new EventCaptureExtension(2000),  // 捕获最近 2000 条事件
    // 请求预处理：在每条消息前加上前缀
    new RequestInterceptorExtension(async (req) => ({
      ...req,
      message: '[已审核] ' + req.message,
    })),
    // 共享状态：扩展间通信
    new SharedStateExtension(new Map([
      ['appName', 'my-agent'],
      ['version', '1.0.0'],
    ])),
  ],
});`,
  },

  // ========== Transformer 转换器 ==========
  {
    id: 'BaseTransformer',
    name: 'BaseTransformer',
    kind: 'class',
    signature: 'class MyTransformer extends BaseTransformer { protected async run(resources, context) {...} }',
    description: '上下文转换器基类。Transformer 在模型调用前执行，按数组顺序对上下文（消息/资源）进行转换，上一个转换器的输出作为下一个的输入。典型用途：上下文裁剪、消息摘要、记忆注入、工具配对校验等。',
    category: 'Transformer 转换器',
    example: `import { BaseTransformer, createRuntime, createDefaultTransformers } from '@aipack-ai/agent';
import type { ContextResource, TransformContext } from '@aipack-ai/agent';

class PrefixInjectTransformer extends BaseTransformer {
  readonly name = 'prefix-inject';

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    // 给最新一条 user 消息内容加上知识库前缀
    const latest = [...resources].reverse().find(r => r.role === 'user');
    if (!latest || typeof latest.content !== 'string') return resources;
    return resources.map(r =>
      r === latest ? { ...r, content: '【知识库上下文】\\n' + latest.content } : r,
    );
  }
}

const runtime = createRuntime({
  // ...model / streamFn
  transformers: [
    new PrefixInjectTransformer(),   // 自定义转换器
    ...createDefaultTransformers(),  // 内置：工具配对、系统消息清理、截断
  ],
});`,
  },
  {
    id: 'BuiltinTransformers',
    name: '内置转换器',
    kind: 'class',
    signature: 'ToolPairingTransformer / TruncationTransformer / ...',
    description: '框架内置多种转换器：ToolPairingTransformer 保证 tool_call 与 tool_result 配对（防止模型解析失败导致上下文损坏）、TruncationTransformer 按资源条数截断、TokenBudgetTransformer 按 Token 预算截断、StateSnapshotTransformer 状态快照、SystemMessageCleanerTransformer 清理重复系统消息。',
    category: 'Transformer 转换器',
    example: `import {
  createDefaultTransformers,
  ToolPairingTransformer,
  TruncationTransformer,
  TokenBudgetTransformer,
  SystemMessageCleanerTransformer,
  StateSnapshotTransformer,
  ensureToolPairing,
} from '@aipack-ai/agent';

// 使用推荐默认配置（开箱即用）
const transformers = createDefaultTransformers();

// 或自定义组合（顺序即执行顺序：快照注入 → 清理 → 条数截断 → Token 截断 → 配对兜底）
const runtime = createRuntime({
  transformers: [
    new StateSnapshotTransformer(() => null), // 可选：提供快照函数则每轮注入状态快照
    new SystemMessageCleanerTransformer(),    // 清理重复 system
    new TruncationTransformer(300),           // 最多 300 条资源
    new TokenBudgetTransformer(0.75),         // 用 75% 的 contextWindow
    new ToolPairingTransformer(),             // 工具配对（必要，放最后兜底修复）
  ],
});`,
  },
  {
    id: 'CompactionOptions',
    name: 'CompactionOptions 内置摘要压缩',
    kind: 'interface',
    signature: 'compaction: { enabled?, triggerRatio?, targetRatio?, onOverflow?, prompt? }',
    description: '内置上下文摘要压缩（RuntimeOptions.compaction，配置后启用）。三级降级链：用户自定义压缩 transformer → 内置摘要压缩 → 硬截断。阈值触发（主路径）：runLoop 每轮模型调用前检查，估算 token 超 contextWindow × triggerRatio 时压缩到 targetRatio——最新消息保留目标的一半，其余经模型通道生成摘要，替换为单条 compactionSummary 消息（资源层 pinned，不会被截断转换器误删；发出前转为带标注的 user 消息，兼容所有 provider）。溢出恢复联动：摘要优先、截断兜底，序列化超窗口 60% 时不发 doomed 请求直接截断。摘要失败（错误/中止/空产出）降级纯丢弃（旧行为），不影响主流程。onCompaction 遥测可观测压缩效果。',
    category: 'Runtime 核心',
    params: [
      { name: 'enabled', type: 'boolean', description: '是否启用，默认 true（显式 false 关闭，恢复仅硬截断行为）' },
      { name: 'triggerRatio', type: 'number', description: '触发阈值：估算 token 占 contextWindow 比例（默认取 contextBudgetRatio，即 0.8）' },
      { name: 'targetRatio', type: 'number', description: '压缩后目标：token 占 contextWindow 比例（默认 0.5，最新消息保留量为其一半）' },
      { name: 'onOverflow', type: 'boolean', description: '溢出恢复时是否也尝试摘要，默认 true；false 则溢出仅硬截断快速重试' },
      { name: 'prompt', type: 'string', description: '摘要指令（默认内置中文指令，可自定义摘要侧重）' },
    ],
    example: `import { createRuntime, createRequest } from '@aipack-ai/agent';

const runtime = createRuntime({
  // ...model / streamFn
  compaction: {
    triggerRatio: 0.8,   // token 超 80% 窗口时触发
    targetRatio: 0.5,    // 压到 50%（最新消息保留一半，其余摘要替换）
    // onOverflow: false, // 溢出时仅快速截断重试（不发起摘要调用）
    // prompt: '...',     // 自定义摘要指令
  },
  telemetry: {
    onCompaction(info) {
      // mode: 'summary' | 'truncate'  trigger: 'threshold' | 'overflow'
      console.log('上下文压缩', info.mode, info.tokensBefore, '->', info.tokensAfter);
    },
  },
});

// 长会话自动压缩：旧历史 → 单条 compactionSummary 消息（pinned，截断不丢）
const result = await runtime.run(createRequest('继续刚才的话题'));`,
  },

  // ========== Result 结果 ==========
  {
    id: 'Result',
    name: 'Result 接口',
    kind: 'interface',
    signature: 'interface Result { content, toolsUsed, usage, stopReason, metadata, success, error?, resources? }',
    description: 'run() 返回的结果结构。包含最终文本、工具使用情况、Token 用量、停止原因、元数据、成功标志，以及可选的错误信息和上下文资源快照。',
    category: 'Result 结果',
    params: [
      { name: 'content', type: 'string', description: '最终回复文本（助手消息纯文本）' },
      { name: 'toolsUsed', type: 'string[]', description: '本次 run 中实际调用过的工具名列表' },
      { name: 'usage', type: 'Record<string, number>', description: 'Token 用量（input/output/total/cacheRead 等）' },
      { name: 'stopReason', type: 'string', description: '停止原因：completed / end_turn / max_turns / terminated / error 等' },
      { name: 'metadata', type: 'Record<string, unknown>', description: '附加元数据（如终止原因 terminateReason）' },
      { name: 'success', type: 'boolean', description: '是否成功（无异常）' },
      { name: 'error', type: 'string', description: '失败原因，仅当 success=false 时存在' },
      { name: 'resources', type: 'ContextResource[]', description: '运行结束时的上下文资源快照' },
    ],
    example: `const result = await runtime.run(req);
if (result.success) {
  console.log('回复:', result.content);
  console.log('使用工具:', result.toolsUsed.join(', ') || '无');
  console.log('Token 输入:', result.usage.input);
  console.log('Token 输出:', result.usage.output);
  console.log('停止原因:', result.stopReason);
} else {
  console.error('运行失败:', result.error);
}`,
  },

  // ========== TaskGraph 任务图 ==========
  {
    id: 'createTaskGraph',
    name: 'createTaskGraph()',
    kind: 'function',
    signature: 'createTaskGraph(): TaskGraph',
    description: '创建空的上下文资源任务依赖图。TaskGraph 以 ContextResource 为节点，按依赖关系（tool_call → tool_result、消息时序）组织，支持拓扑排序与统计分析。Runtime 内部用它构建任务图后再链式转换。',
    category: 'TaskGraph 任务图',
    returns: 'TaskGraph 实例（addNode / addEdge / setEntry / topologicalSort / getAll / getStats）',
    example: `import { createTaskGraph, createMessageResource } from '@aipack-ai/agent';

const graph = createTaskGraph();
const a = createMessageResource({ role: 'user', content: [{ type: 'text', text: '查天气' }] });
const b = createMessageResource({ role: 'assistant', content: [] });
graph.addNode(a);
graph.addNode(b);
graph.addEdge(a.id, b.id, 'sequence');
console.log(graph.topologicalSort());`,
  },
  {
    id: 'buildTaskGraph',
    name: 'buildTaskGraph()',
    kind: 'function',
    signature: 'buildTaskGraph(messages: Message[]): TaskGraph',
    description: '从消息历史构建任务依赖图：自动补充 tool_call → tool_result 依赖边。配合 graphToMessages() 可做无损的图态往返（重排/重建消息序列）。',
    category: 'TaskGraph 任务图',
    params: [
      { name: 'messages', type: 'Message[]', required: true, description: '消息历史（用户/助手/工具结果）' },
    ],
    returns: 'TaskGraph',
    example: `import {
  buildTaskGraph, graphToMessages,
  analyzeToolChains, findOrphanedToolCalls, getGraphStats,
} from '@aipack-ai/agent';

const graph = buildTaskGraph(runtime.getMessages());

// 分析工具调用链：每个 tool_call 是否有结果、是否错误
analyzeToolChains(graph).forEach(c => {
  console.log(c.toolName, c.hasResult, c.isError);
});

// 找出没有结果的孤儿 tool_call（中断恢复场景）
console.log(findOrphanedToolCalls(graph));

// 图统计：节点总数 / 按类型分布 / 孤儿数 / 是否含错误
console.log(getGraphStats(graph));

// 图 → 消息（拓扑排序后还原）
const messages = graphToMessages(graph);`,
  },

  // ========== Tapable 钩子策略 ==========
  {
    id: 'setTapFailurePolicy',
    name: 'setTapFailurePolicy()',
    kind: 'function',
    signature: "setTapFailurePolicy(policy: 'warn' | 'strict' | 'silent'): void",
    description: '设置全局 Tapable 钩子失败策略：某个 tap（钩子监听器）抛错时的处理方式。strict 抛出中断、warn 告警继续（默认）、silent 静默继续。配套 getTapFailurePolicy() 读取当前策略；setTapErrorHandler() 注册全局错误处理器（Runtime 构造时用它接入 telemetry onHookError 上报），传 undefined 清除。',
    category: 'Tapable 钩子策略',
    params: [
      { name: 'policy', type: "'warn' | 'strict' | 'silent'", required: true, description: '失败策略：warn 告警继续 / strict 抛出 / silent 静默' },
    ],
    example: `import { setTapFailurePolicy, setTapErrorHandler } from '@aipack-ai/agent';

// 开发期严格模式：钩子抛错立即暴露
setTapFailurePolicy('strict');

// 生产期接遥测：所有 tap 失败上报 onHookError，不中断主流程
setTapFailurePolicy('warn');
setTapErrorHandler((info) => {
  // info: { hook, tap, error }
  reportToTelemetry(info);
});`,
  },

  // ========== ContextResource 资源 ==========
  {
    id: 'createMessageResource',
    name: 'createMessageResource()',
    kind: 'function',
    signature: 'createMessageResource(message: Message): ContextResource',
    description: '把消息包装为上下文资源节点（ResourceRole: user/assistant/tool）。同族工厂还有 createToolCallResource() / createToolResultResource()（直接以 tool_call / tool_result 内容建节点）。资源是 Transformer 链的统一操作单元。',
    category: 'ContextResource 资源',
    params: [
      { name: 'message', type: 'Message', required: true, description: '待包装的消息对象' },
    ],
    returns: 'ContextResource（含 id、type、role、payload、依赖元数据）',
    example: `import {
  messageToResource, resourceToMessage,
  messagesToResources, resourcesToMessages,
} from '@aipack-ai/agent';

// 单条转换
const resource = messageToResource(message);
const back = resourceToMessage(resource);

// 批量往返（buildTaskGraph 内部即用这对函数）
const resources = messagesToResources(messages);
const restored = resourcesToMessages(resources);

// 从资源提取内容
extractToolCallsFromResource(resource);  // ToolCallContent[]
extractTextFromResource(resource);       // string`,
  },

  // ========== Result 结果 ==========
  {
    id: 'createResult',
    name: 'createResult() / ResultBuilder',
    kind: 'function',
    signature: 'createResult(partial: Partial<Result>): Result',
    description: '结果工厂：以默认值补全 Result 结构（content 空串、toolsUsed 空数组、success true 等）。createErrorResult() 一步构造失败结果；ResultBuilder 链式构建复杂结果；ResultAggregator 聚合多个部分结果（分块合并场景）。另有 buildResultFromMessages / buildResultFromAssistantMessage / buildResultWithResources 从消息/资源构建。',
    category: 'Result 结果',
    params: [
      { name: 'partial', type: 'Partial<Result>', required: true, description: '结果字段（缺省部分自动补默认值）' },
    ],
    returns: '完整的 Result',
    example: `import { createResult, createErrorResult, ResultAggregator } from '@aipack-ai/agent';

const ok = createResult({ content: '完成' });
const fail = createErrorResult(new Error('模型超时'), { stopReason: 'error' });

// 聚合多个分块结果
const agg = new ResultAggregator();
agg.add(chunk1);
agg.add(chunk2);
const merged = agg.build();`,
  },

  // ========== AI 模型层 ==========
  {
    id: 'getBuiltinModels',
    name: 'getBuiltinModels() / getBuiltinProviders()',
    kind: 'function',
    signature: "getBuiltinModels(providerId: string): AiModel[]  ·  getBuiltinProviders(): Array<{ id, name, baseUrl, ... }>",
    description: '查询内置模型目录与提供商列表。BUILTIN_PROVIDERS 为常量数组；hasProviderConfigured(providerId) 检测对应 *_API_KEY 环境变量是否已配置（CLI 默认模型探测即基于它）。主入口重导出常用子集，完整 AI surface 见 @aipack-ai/agent/ai 子路径。',
    category: 'AI 模型层',
    params: [
      { name: 'providerId', type: 'string', required: true, description: '提供商 id（deepseek / openai / anthropic / google ...）' },
    ],
    returns: 'AiModel[] / 提供商元信息数组',
    example: `import {
  getBuiltinProviders, getBuiltinModels,
  hasProviderConfigured, getEnvApiKey, BUILTIN_PROVIDERS,
} from '@aipack-ai/agent';

// 已配置 Key 的提供商（CLI 默认模型探测逻辑）
const configured = getBuiltinProviders().filter(p => hasProviderConfigured(p.id));

// 某提供商的全部内置模型（含能力标注：input / reasoning / contextWindow）
const models = getBuiltinModels('deepseek');
models.forEach(m => console.log(m.id, m.input, m.contextWindow));

console.log(BUILTIN_PROVIDERS.length); // 内置提供商总数
console.log(getEnvApiKey('deepseek')); // 读取对应环境变量`,
  },

  // ========== 权限安全 ==========
  {
    id: 'createAllowAllPolicy',
    name: 'createAllowAllPolicy()',
    kind: 'function',
    signature: 'createAllowAllPolicy(): PermissionPolicy',
    description: '全部放行策略。与 createDenyAllPolicy()（全部拒绝）、createAllowListPolicy()（白名单）同族，适用于测试或显式信任场景；生产环境建议用 createPermissionPolicy() 声明规则。',
    category: '权限安全',
    returns: 'PermissionPolicy（所有请求决策 allow）',
    example: `import { createAllowAllPolicy } from '@aipack-ai/agent';

const runtime = createRuntime({
  // ... 其他配置
  permissionPolicy: createAllowAllPolicy(), // 测试场景：全部放行
});`,
  },
];

export const apiCategories = [...new Set(apiList.map(item => item.category))];
