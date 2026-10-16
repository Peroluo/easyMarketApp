/**
 * runtime/sandbox/net-proxy - 审计代理 forwarder + secrets broker 宿主侧（M6）
 *
 * net.mode === 'proxy' 的实现端：宿主进程内启动本地 HTTP(S) forwarder
 * （127.0.0.1 随机端口），worker env 注入 HTTP_PROXY/HTTPS_PROXY 指向它，
 * forwarder 按 spec.net.hosts 白名单放行并记录全量请求审计日志
 * （域名、方法、字节量；不记 body）。
 *
 * 强制力如实声明（与 R6 风险声明一致）：proxy 定位为"审计 + 宽松"——
 * - Tier 1（subprocess）与 bwrap 沙箱内 HTTP_PROXY 只是 env 约定，
 *   不合作进程可绕过直连（强制断网只有 deny 的 --unshare-net）；
 * - macOS Seatbelt 可按 remote 地址强制（proxy 只放行 127.0.0.1:port），
 *   见 seatbelt.ts；
 * - TLS 透视局限：CONNECT 隧道内流量不可见（SNI 域名可见即可审计）。
 *
 * secrets broker 宿主侧裁决在 subprocess.ts runProtocolSession（协议层）；
 * 本文件只负责网络面。
 */

import * as http from 'node:http';
import * as net from 'node:net';
import type { SandboxEvent, SandboxEventType, SandboxSpec } from '../../core/sandbox';

// ─── 审计 ───────────────────────────────────────────────────────────

/** 单次请求/隧道审计条目（域名、方法、字节量；不记 body） */
export interface NetAuditEntry {
  /** 请求目标 hostname（小写） */
  host: string;
  /** HTTP 方法（CONNECT 隧道为 'CONNECT'） */
  method: string;
  /** 请求+响应总字节量 */
  bytes: number;
  /** 是否白名单放行 */
  allowed: boolean;
  /** 拒绝原因（allowed=false 时给出来源） */
  reason?: 'host-not-allowed';
  /** 时间戳（Date.now()） */
  at: number;
}

// ─── forwarder ──────────────────────────────────────────────────────

export interface NetForwarderOptions {
  /** 放行域名白名单（精确 hostname 匹配、大小写不敏感；缺省/空 = 全拒，等效 deny） */
  hosts: readonly string[];
  /** 白名单拒绝回调（provider 包装为 violation 遥测事件） */
  onViolation?: (info: { host: string; method: string }) => void;
}

export interface NetForwarder {
  /** 监听端口（127.0.0.1 随机分配） */
  readonly port: number;
  /** 审计日志（会话期间累积；不记 body） */
  readonly auditLog: readonly NetAuditEntry[];
  /** 关闭 server 与全部活跃连接（会话结束收尾） */
  close(): Promise<void>;
}

/** 提取请求目标 hostname（CONNECT 的 "host:port" 与绝对 URI 两种形态；小写） */
function extractHostname(connectUrl: string | undefined, requestUrl: string, hostHeader?: string): string {
  // CONNECT 形态："example.com:443" / "[::1]:443" → 借 URL 解析规避 IPv6 括号切分
  if (connectUrl !== undefined && connectUrl !== '') {
    try {
      return new URL(`http://${connectUrl}`).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  // forward proxy 绝对 URI 形态：http://host:port/path（相对形态退回 Host 头）
  try {
    return new URL(requestUrl, `http://${hostHeader ?? 'localhost'}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 启动本地 HTTP(S) forwarder（127.0.0.1 随机端口）。
 * - 普通请求（forward proxy 绝对 URI）：白名单校验 → http.request 转发；
 * - CONNECT 隧道（HTTPS）：白名单校验 → net.connect 双向管道；
 * - 白名单外：403 拒绝 + onViolation + 审计记录（allowed: false）。
 */
export function startNetForwarder(opts: NetForwarderOptions): Promise<NetForwarder> {
  const allowedHosts = new Set(opts.hosts.map(h => h.toLowerCase()));
  const auditLog: NetAuditEntry[] = [];

  const server = http.createServer((req, res) => {
    // forward proxy 形态：req.url 为绝对 URI（http://host:port/path）
    const host = extractHostname(undefined, req.url ?? '/', req.headers.host);
    const method = req.method ?? 'GET';
    const entry: NetAuditEntry = { host, method, bytes: 0, allowed: allowedHosts.has(host), at: Date.now() };
    auditLog.push(entry);
    const deny = (): void => {
      opts.onViolation?.({ host, method });
      entry.reason = 'host-not-allowed';
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`aipack sandbox proxy: host "${host}" is not allowed`);
    };
    if (!entry.allowed) {
      deny();
      return;
    }
    try {
      // 转发：保留原 headers（Host 即目标 host）；目标连接失败按代理错误回传
      const upstream = http.request(req.url ?? '/', { method, headers: req.headers }, up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.on('data', (c: Buffer) => { entry.bytes += c.length; });
        up.pipe(res);
      });
      req.on('data', (c: Buffer) => { entry.bytes += c.length; });
      req.pipe(upstream);
      upstream.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`aipack sandbox proxy: upstream error: ${(err as Error).message}`);
        } else {
          res.destroy();
        }
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`aipack sandbox proxy: invalid target: ${(err as Error).message}`);
      }
    }
  });

  // CONNECT 隧道（HTTPS 流量不解密，白名单按目标 host 判定 = SNI 可见面）
  server.on('connect', (req, clientSocket, head) => {
    const host = extractHostname(req.url, '/');
    const method = 'CONNECT';
    const entry: NetAuditEntry = { host, method, bytes: 0, allowed: allowedHosts.has(host), at: Date.now() };
    auditLog.push(entry);
    if (!entry.allowed) {
      entry.reason = 'host-not-allowed';
      opts.onViolation?.({ host, method });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    let port = 443;
    let hostname = host;
    try {
      const target = new URL(`http://${req.url ?? ''}`);
      port = Number(target.port || 443);
      hostname = target.hostname;
    } catch {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head !== undefined && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // 字节审计：双向 data 事件计数（pipe 之外旁路监听，不消费流）
    upstream.on('data', (c: Buffer) => { entry.bytes += c.length; });
    clientSocket.on('data', (c: Buffer) => { entry.bytes += c.length; });
    upstream.on('error', () => { clientSocket.destroy(); });
    clientSocket.on('error', () => { upstream.destroy(); });
    clientSocket.on('close', () => { upstream.destroy(); });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('net forwarder: unexpected listen address'));
        return;
      }
      resolve({
        port: addr.port,
        auditLog,
        close: () =>
          new Promise<void>(resolveClose => {
            // closeAllConnections（Node 18.2+）：强断活跃隧道，防泄漏残留连接
            server.closeAllConnections?.();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

// ─── worker env 注入（provider 共用）────────────────────────────────

/** worker 侧 loopback 自身请求不走代理（防环） */
const NO_PROXY_VALUE = '127.0.0.1,localhost';

/**
 * proxy env 注入集：大写/小写变体兼顾主流客户端（curl 认小写 http_proxy、
 * Node/undici 等认大写）。地址用 127.0.0.1 IP 形态——worker 内无需 DNS
 * 解析（目标域名解析发生在宿主 forwarder 侧）。
 */
export function netProxyEnv(port: number): Record<string, string> {
  const proxy = `http://127.0.0.1:${port}`;
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: NO_PROXY_VALUE,
    no_proxy: NO_PROXY_VALUE,
  };
}

// ─── provider 接入 helper ────────────────────────────────────────────

/** provider 侧事件发射器构造（runProtocolSession 同款事件形态） */
export type SandboxEmit = (type: SandboxEventType, detail?: Record<string, unknown>) => void;

export function makeSandboxEmit(req: {
  toolName: string;
  toolCallId: string;
  spec: SandboxSpec;
  onEvent?: (event: SandboxEvent) => void;
}): SandboxEmit {
  return (type, detail) => {
    req.onEvent?.({
      type,
      toolName: req.toolName,
      toolCallId: req.toolCallId,
      strategy: req.spec.strategy,
      ...(detail !== undefined ? { detail } : {}),
    });
  };
}

/** proxy 会话句柄：forwarder + 注入 env（会话结束 close） */
export interface NetProxySession {
  forwarder: NetForwarder;
  /** 合并进 worker env 的代理变量（覆盖 spec.env 同名键——proxy 模式下出口归框架） */
  env: Record<string, string>;
}

/**
 * spec.net.mode === 'proxy' 时启动 forwarder；非 proxy 模式返回 undefined。
 * forwarder 启动失败（端口耗尽等）→ fail-closed：发 degraded 事件并返回
 * undefined（调用方按 deny 语义处理，proxy < deny 宽松度、降级方向正确）。
 */
export async function startNetProxyForSpec(
  spec: SandboxSpec,
  emit: SandboxEmit,
): Promise<NetProxySession | undefined> {
  if (spec.net.mode !== 'proxy') return undefined;
  let forwarder: NetForwarder;
  try {
    forwarder = await startNetForwarder({
      hosts: spec.net.hosts ?? [],
      onViolation: ({ host, method }) => emit('violation', { kind: 'net', host, method }),
    });
  } catch (err) {
    emit('degraded', {
      reason: 'net-proxy-fallback-deny',
      error: (err as Error)?.message ?? String(err),
    });
    return undefined;
  }
  return { forwarder, env: netProxyEnv(forwarder.port) };
}
