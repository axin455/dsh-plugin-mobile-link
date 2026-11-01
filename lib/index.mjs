import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import QRCode from 'qrcode'
import { WebSocketServer } from 'ws'

import devicesModule from './devices.js'
import { createDshHostAdapter } from './host-adapter.mjs'
import { handlePluginQuery, PLUGIN_REQUEST_TYPES } from './plugin-management.mjs'
import { createSessionFollower } from './session-follower.mjs'
import { parseSessionTarget } from './session-target.mjs'
import { stringifyWireFrame } from './wire-json.mjs'

const { createRegistry } = devicesModule

const PROTOCOL_REVISION = 4
const SNAPSHOT_MAX_EVENTS = 80
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000

function log(...args) {
  console.log(`[mobile-link ${new Date().toISOString()} pid=${process.pid}]`, ...args)
}

// 只列出真正可能被手机访问到的私有网段地址。手机/平板走的是 Wi-Fi，
// 所以无线网卡必须排在前面：常见情况下有线是 192.168.x.x、无线是 10.x，
// 按系统枚举顺序会把平板连不上的有线地址塞进二维码的第一位。
function lanEndpoints(port, wsPath) {
  const wireless = []
  const others = []
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    const isWireless = /wlan|wi-?fi|wireless|802\.11|无线/i.test(name)
    for (const item of interfaces[name] || []) {
      if (item.internal || item.family !== 'IPv4') continue
      if (!/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(item.address)) continue
      const bucket = isWireless ? wireless : others
      if (wireless.includes(item.address) || others.includes(item.address)) continue
      bucket.push(item.address)
    }
  }
  return [...wireless, ...others].map((address) => `ws://${address}:${port}${wsPath}`)
}

function createGatewayIdentity() {
  const file = path.join(os.homedir(), '.dsh', 'mobile-link-gateway.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed.gatewayId === 'string' && parsed.gatewayId) return parsed.gatewayId
  } catch {
    // first run
  }
  const gatewayId = crypto.randomUUID()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify({ version: 1, gatewayId }), { mode: 0o600 })
  } catch (error) {
    log(`gateway identity was not persisted: ${error.message}`)
  }
  return gatewayId
}

function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
  socket.destroy()
}

function requestedProtocols(req) {
  const raw = req.headers['sec-websocket-protocol']
  if (typeof raw !== 'string') return []
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function credentialOf(req, protocols) {
  for (const protocol of protocols) {
    if (protocol.startsWith('dsh-pair.')) return { kind: 'pair', value: protocol.slice('dsh-pair.'.length) }
    if (protocol.startsWith('dsh-auth.')) return { kind: 'token', value: protocol.slice('dsh-auth.'.length) }
  }
  const header = req.headers.authorization
  if (typeof header === 'string' && /^Bearer /i.test(header)) return { kind: 'token', value: header.slice(7).trim() }
  return undefined
}

function deviceIdOf(protocols) {
  for (const protocol of protocols) {
    if (protocol.startsWith('dsh-device.')) return protocol.slice('dsh-device.'.length)
  }
  return undefined
}

function deviceNameOf(protocols) {
  for (const protocol of protocols) {
    if (!protocol.startsWith('dsh-device-name.')) continue
    try {
      return Buffer.from(protocol.slice('dsh-device-name.'.length), 'base64url').toString('utf8')
    } catch {
      return undefined
    }
  }
  return undefined
}

function textOfBlocks(blocks, type = 'text') {
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block && block.type === type && typeof block.text === 'string') text += block.text
    else if (block && block.type === 'tool-result' && Array.isArray(block.content)) text += textOfBlocks(block.content, type)
  }
  return text
}

/// Minimal, owned event projection: the app renders main messages and folds
/// reasoning / tool details behind a collapsible row.
function wireEvent(sessionId, event) {
  const data = event && typeof event.data === 'object' && event.data ? event.data : {}
  const base = { kind: 'event', sessionId, seq: event.seq, time: event.time }
  if (event.type === 'user/message') {
    // 会话里还有运行时上下文、技能目录、时间快照、模型切换提示等内部消息。
    // 桌面 WebUI 不把它们当作用户气泡；手机上也必须过滤，否则历史会被
    // 几十 KB 的系统上下文撑爆，滚动到中段只剩空白。
    const source = data.source && typeof data.source === 'object' ? data.source : {}
    if (source.form) return undefined
    if (typeof source.kind === 'string' && source.kind !== 'user' && source.kind !== 'command') {
      return undefined
    }
    return { ...base, event: { type: 'user/message', text: textOfBlocks(data.content) } }
  }
  if (event.type === 'assistant/message') {
    const blocks = data.message && Array.isArray(data.message.content)
      ? data.message.content
      : []
    const text = textOfBlocks(blocks)
    const reasoning = textOfBlocks(blocks, 'reasoning').trim()
    const tools = blocks
      .filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string')
      .map((block) => block.name)
    return {
      ...base,
      event: {
        type: 'assistant/message',
        turn: data.turn,
        step: data.step,
        text,
        ...(reasoning ? { reasoning: reasoning.length > 8000 ? `${reasoning.slice(0, 8000)}…` : reasoning } : {}),
        ...(tools.length ? { tools } : {}),
        ...(data.interrupted === true ? { interrupted: true } : {}),
      },
    }
  }
  if (event.type === 'tool/call') {
    const args = typeof data.arguments === 'string'
      ? data.arguments
      : JSON.stringify(data.arguments ?? '')
    return {
      ...base,
      event: {
        type: 'tool/call',
        name: typeof data.name === 'string' ? data.name : '工具',
        arguments: args.length > 2000 ? `${args.slice(0, 2000)}…` : args,
      },
    }
  }
  if (event.type === 'tool/result') {
    const message = data.message && typeof data.message === 'object' ? data.message : {}
    const text = textOfBlocks(message.content)
    if (!text.trim()) return undefined
    return {
      ...base,
      event: {
        type: 'tool/result',
        text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      },
    }
  }
  if (event.type === 'turn/end' || event.type === 'turn/start') {
    return { ...base, event: { type: event.type, turn: data.turn } }
  }
  if (event.type === 'session/title' && typeof data.title === 'string') {
    return { ...base, event: { type: 'session/title', title: data.title } }
  }
  return undefined
}

async function listSessions(api) {
  const result = await api.sessions.list({})
  const all = Array.isArray(result && result.items) ? result.items : []
  // 子会话（subagent）只能凭父地址打开，而列表里没有父会话 id：放进手机列表
  // 只会得到一堆打不开的空会话。桌面端的主列表同样不展示它们，这里保持一致。
  const items = all.filter((item) => {
    const values = (item && item.projections && item.projections.values) || {}
    return values.subagent === null || values.subagent === undefined
  })
  return {
    kind: 'sessions',
    items: items.map((item) => {
      const values = (item && item.projections && item.projections.values) || {}
      return {
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        running: item.running === true,
        blank: item.blank === true,
        projections: {
          ...(item.projections && item.projections.asOfSeq !== undefined
            ? { asOfSeq: item.projections.asOfSeq }
            : {}),
          values: typeof values.title === 'string' ? { title: values.title } : {},
        },
      }
    }),
  }
}

async function statsFrame(api, target) {
  const snapshot = await api.sessions.history({ ...target, maxMessages: 1 })
  const sessionId = target.sessionId
  const values = (snapshot && snapshot.projections && snapshot.projections.values) || {}
  return {
    kind: 'session-stats',
    sessionId,
    asOfSeq: snapshot && snapshot.projections ? snapshot.projections.asOfSeq : undefined,
    sessionStats: values.sessionStats || null,
    tokenUsage: values.tokenUsage || null,
    contextPressure: values.contextPressure || null,
  }
}

function valueAt(root, path) {
  let current = root
  for (const key of path || []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

async function readAccountFrame(api) {
  const [profileResult, balanceResult, stateResult] = await Promise.allSettled([
    api.account.profile(),
    api.account.balance(),
    api.account.state(),
  ])
  const state = stateResult.status === 'fulfilled' ? stateResult.value : null
  const profile = profileResult.status === 'fulfilled'
    && profileResult.value && profileResult.value.status === 'ready'
    ? profileResult.value.value : null
  const wallet = balanceResult.status === 'fulfilled'
    && balanceResult.value && balanceResult.value.status === 'ready'
    ? balanceResult.value : null
  return {
    kind: 'account-profile',
    signedIn: !!profile || state?.status === 'credential-stored',
    profile: profile
      ? {
          name: typeof profile.name === 'string' ? profile.name : '',
          contact: typeof profile.contact === 'string' ? profile.contact : '',
          avatarUrl: typeof profile.avatarUrl === 'string' ? profile.avatarUrl : '',
        }
      : null,
    balances: Array.isArray(wallet?.value) ? wallet.value : [],
    bonusWallets: Array.isArray(wallet?.bonusWallets) ? wallet.bonusWallets : [],
    accountState: state?.status ?? 'unknown',
  }
}

/**
 * 手机端「本地直连」要和电脑共用同一套供应商凭据：先按 DSH 的 provider
 * 配置找到 apiKeyEnv（凭据引用名），再用 credentials 服务解析出真实 Key。
 * 凭据只在配对连接上单向下发，不落日志。
 */
async function readCredentialsFrame(api, credentialsService) {
  const [providersResult, describedResult, hostResult] = await Promise.allSettled([
    api.llm.providers(),
    api.settings.describe(),
    api.host.describe(),
  ])
  if (providersResult.status !== 'fulfilled') return { kind: 'api-credential', credentials: [] }
  const providers = Array.isArray(providersResult.value?.providers)
    ? providersResult.value.providers : []
  const described = describedResult.status === 'fulfilled' ? describedResult.value : null
  const namespaces = new Map(
    (Array.isArray(described?.namespaces) ? described.namespaces : [])
      .map(item => [item.ns, item]),
  )
  const host = hostResult.status === 'fulfilled' ? hostResult.value : null
  const credentials = []
  for (const provider of providers) {
    const namespace = namespaces.get(provider.settingsNs)
    const namespaceValue = namespace
      ? (namespace.value ?? namespace.user ?? namespace.base ?? namespace.config)
      : undefined
    const config = valueAt(namespaceValue, provider.settingsPath)
    if (!config || typeof config !== 'object') continue
    const rawRef = config.apiKeyEnv
    const ref = typeof rawRef === 'string'
      ? rawRef
      : (rawRef && typeof rawRef === 'object' && typeof rawRef.ref === 'string' ? rawRef.ref : '')
    if (!ref || !credentialsService || typeof credentialsService.resolve !== 'function') continue
    let secret
    try {
      secret = await credentialsService.resolve(ref)
    } catch (error) {
      log(`credential ${ref} could not be resolved: ${error.message}`)
      continue
    }
    const apiKey = typeof secret?.value === 'string' ? secret.value : ''
    if (!apiKey) continue
    const baseUrl = typeof config.baseURL === 'string' && config.baseURL
      ? config.baseURL
      : provider.defaultBaseURL
    if (typeof baseUrl !== 'string' || !baseUrl) continue
    const api = typeof config.api === 'string' && config.api ? config.api : 'openai-completions'
    // 手机端直连只实现了 OpenAI 兼容的 /chat/completions，其他协议不下发，
    // 避免把用不了的 Key 塞进手机本地模式。
    if (api !== 'openai-completions') continue
    const models = (Array.isArray(config.models) ? config.models : [])
      .filter(item => item && typeof item.id === 'string' && item.id)
      .map(item => ({ id: item.id, name: typeof item.name === 'string' && item.name ? item.name : item.id }))
    credentials.push({
      provider: provider.provider,
      displayName: typeof provider.displayName === 'string' && provider.displayName
        ? provider.displayName : provider.provider,
      baseUrl,
      api,
      apiKey,
      last4: apiKey.slice(-4),
      models,
      defaultModel: host?.defaultProvider === provider.provider
        ? host.defaultModel
        : (models[0]?.id ?? ''),
    })
  }
  credentials.sort((a, b) => {
    const aDefault = a.provider === host?.defaultProvider ? 1 : 0
    const bDefault = b.provider === host?.defaultProvider ? 1 : 0
    return bDefault - aDefault
  })
  return { kind: 'api-credential', credentials, defaultProvider: host?.defaultProvider ?? null }
}

async function readModelsFrame(api, sessionId) {
  if (sessionId) {
    const models = await api.sessions.models({ sessionId })
    return {
      kind: 'models',
      sessionId,
      current: models?.current ?? null,
      routable: models?.routable === true,
      groups: Array.isArray(models?.groups) ? models.groups : [],
      failures: Array.isArray(models?.failures) ? models.failures : [],
    }
  }
  const [catalog, host] = await Promise.all([api.llm.models(), api.host.describe()])
  return {
    kind: 'models',
    sessionId: null,
    default: host?.defaultProvider && host?.defaultModel
      ? { provider: host.defaultProvider, model: host.defaultModel }
      : null,
    current: null,
    groups: Array.isArray(catalog?.groups) ? catalog.groups : [],
    failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
  }
}

// 本地模式也能用电脑上的 DeepSeek 账号模型：只下发账号自带的模型组，
// 其它供应商仍然走已同步的 API Key。
async function readAccountModelsFrame(api) {
  const catalog = await api.llm.models()
  const groups = Array.isArray(catalog?.groups)
    ? catalog.groups.filter(group => group && group.id === 'deepseek-account')
    : []
  return { kind: 'account-models', groups }
}

function modelSelectionOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) return undefined
  return {
    provider,
    model,
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  }
}

async function admitMessage(api, msg) {
  const target = parseSessionTarget(msg, { optional: true })
  if (target.error) return { ...target.error, requestType: 'message' }
  const text = typeof msg.text === 'string' ? msg.text.trim() : ''
  if (!text) {
    return {
      kind: 'error',
      code: 'bad-request',
      requestType: 'message',
      message: 'message requires a non-empty text',
      ...target.value,
    }
  }
  const mode = msg.mode === 'steer' ? 'steer' : 'queue'
  const selection = modelSelectionOf(msg.model)
  let sessionId = target.value.sessionId
  if (!sessionId) {
    const created = await api.sessions.create({})
    sessionId = created.sessionId
  }
  // 手机端在新建会话里先选模型再发首条消息：必须先落模型选择，
  // 否则 DSH 会用「上一次对话的默认模型」跑这一轮。
  if (selection) {
    await api.sessions.selectModel({ sessionId, ...selection })
  }
  const response = await api.sessions.prompt({
    ...target.value,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
    ...(typeof msg.clientTimeZone === 'string' && msg.clientTimeZone.trim()
      ? { clientTimeZone: msg.clientTimeZone.trim() }
      : {}),
  })
  return {
    kind: 'sent',
    sessionId,
    mode,
    ...(response && response.command ? { command: response.command } : {}),
  }
}

function requireSessionId(msg) {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : ''
  if (!sessionId) {
    return {
      error: {
        kind: 'error',
        code: 'bad-request',
        requestType: msg.type,
        message: 'sessionId must be a non-empty string',
        ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
      },
    }
  }
  return { value: sessionId }
}

function pairingPayload({ registry, gatewayId, gatewayName, port, wsPath }) {
  const pairing = registry.createPairing(gatewayName)
  const endpoints = lanEndpoints(port, wsPath)
  const publicUrl = endpoints[0]
  if (!publicUrl) throw new Error('没有可用的局域网地址：请确认电脑已连上 Wi-Fi 或有线网络')
  const body = {
    version: 2,
    publicUrl,
    pairingCode: pairing.code,
    expiresAt: pairing.expiresAt,
    serverTime: Date.now(),
    endpoints,
    gatewayId,
    gatewayName,
  }
  // Base64URL without padding, exactly what the app decodes.
  const raw = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  return { raw, body }
}

function htmlPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 移动连接</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:15px/1.6 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#f2f2f4;color:#1c1c1e}
@media (prefers-color-scheme:dark){body{background:#111;color:#ededed}}
main{max-width:720px;margin:32px auto;padding:0 20px}
.card{background:#fff;border:1px solid #e3e3e5;border-radius:16px;padding:20px;margin-bottom:16px}
@media (prefers-color-scheme:dark){.card{background:#1c1c1e;border-color:#2c2c2e}}
h1{font-size:20px;margin:0 0 4px}
p{margin:6px 0;color:#6b6b70}
button{font:inherit;padding:10px 18px;border-radius:999px;border:1px solid #1c1c1e;background:#1c1c1e;color:#fff;cursor:pointer}
button.ghost{background:transparent;color:inherit}
#qr{display:block;margin:16px auto 0;width:240px;height:240px;background:#fff;border-radius:12px;padding:8px}
code{word-break:break-all;font-size:12px}
ul{margin:8px 0 0;padding-left:18px}
li{margin:4px 0}
</style></head>
<body><main>
<h1>DSH 移动连接</h1>
<p>用手机/平板 App 扫描下面的二维码即可配对。这个页面只在本机可访问。</p>
<div class="card">
  <button id="regen">生成配对二维码</button>
  <p id="hint">配对码 5 分钟内有效，只用一次。</p>
  <img id="qr" alt="" hidden>
  <p><code id="raw"></code></p>
</div>
<div class="card">
  <h1 style="font-size:16px">已配对设备</h1>
  <ul id="devices"><li>加载中…</li></ul>
</div>
<script>
const qr = document.getElementById('qr')
const raw = document.getElementById('raw')
const hint = document.getElementById('hint')
const devices = document.getElementById('devices')
async function refreshDevices(){
  try {
    const res = await fetch('mobile-link/status')
    const data = await res.json()
    devices.innerHTML = data.devices && data.devices.length
      ? data.devices.map(d => '<li>' + d.displayName + ' · ' + (d.online ? '在线' : '离线') + '</li>').join('')
      : '<li>还没有设备，先扫码配对。</li>'
  } catch (e) { devices.innerHTML = '<li>读取失败</li>' }
}
async function pair(){
  hint.textContent = '正在生成…'
  try {
    const res = await fetch('mobile-link/pair', {method:'POST'})
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || '生成失败')
    qr.src = data.qr
    qr.hidden = false
    raw.textContent = data.raw
    hint.textContent = '扫完二维码后，这里会显示设备在线。'
  } catch (e) { hint.textContent = '生成失败：' + e.message }
}
document.getElementById('regen').addEventListener('click', pair)
pair()
setInterval(refreshDevices, 3000)
refreshDevices()
</script>
</main></body></html>`
}

const plugin = {
  name: 'mobile-link',
  inject: ['webServer', 'typertGateway', 'connection', 'llm'],
  apply(ctx, config) {
    // A broken row must never take the host down: log and stay inert instead.
    try {
      start(ctx, config)
    } catch (error) {
      console.error('[mobile-link] failed to start:', error && error.message ? error.message : error)
    }
  },
}

function start(ctx, config) {
  if (typeof ctx.connection?.createPeer !== 'function') {
    throw new Error('mobile-link requires DSH 0.2.1-rc.2 or later (Connection.createPeer)')
  }
    const options = {
      lanHost: '0.0.0.0',
      lanPort: 3090,
      gatewayName: '',
      wsPath: '/ws/mobile',
      // 扫码配对后把电脑上的供应商 API Key 同步给手机，供「本地」直连使用。
      syncCredentials: true,
      ...(config || {}),
    }
    const wsPath = options.wsPath
    log(`applying: lanHost=${options.lanHost} lanPort=${options.lanPort} path=${wsPath} dshWebPort=${ctx.webServer.port}`)
    const gatewayName = typeof options.gatewayName === 'string' && options.gatewayName.trim()
      ? options.gatewayName.trim().slice(0, 80)
      : os.hostname().slice(0, 80)
    const gatewayId = createGatewayIdentity()

    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    const api = createDshHostAdapter(ctx.typertGateway, peer, ctx.connection)
    const registry = createRegistry(
      path.join(os.homedir(), '.dsh', 'mobile-link-devices.json'),
      { pairingTtlMs: DEFAULT_PAIRING_TTL_MS },
    )

    const clients = new Set()
    let archivedSessionIds = null
    let boundPort = options.lanPort
    const chatControllers = new Map()
    const chatLogDir = path.join(os.homedir(), '.dsh', 'mobile-link-chats')

    // Model-only completion: no Agent, no tools, no workspace. Used by the
    // phone's local chat and the PC "chat" side of the PC scope.
    const runChat = async (msg, send) => {
      const requestId = typeof msg.requestId === 'string' && msg.requestId.trim()
        ? msg.requestId.trim().slice(0, 80)
        : crypto.randomUUID()
      const provider = typeof msg.provider === 'string' ? msg.provider.trim() : ''
      const model = typeof msg.model === 'string' ? msg.model.trim() : ''
      if (!provider || !model) {
        send({ kind: 'chat-error', requestId, message: 'chat requires provider and model' })
        return
      }
      const rawMessages = Array.isArray(msg.messages) ? msg.messages : []
      const messages = []
      let totalChars = 0
      for (const item of rawMessages.slice(-40)) {
        if (!item || typeof item !== 'object') continue
        const role = item.role === 'assistant' ? 'assistant'
          : item.role === 'system' ? 'system' : 'user'
        let text = ''
        if (typeof item.content === 'string') {
          text = item.content
        } else if (Array.isArray(item.content)) {
          text = item.content
            .filter(block => block && block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n')
        }
        if (!text.trim()) continue
        totalChars += text.length
        if (totalChars > 200000) {
          send({ kind: 'chat-error', requestId, message: 'chat history is too large' })
          return
        }
        const normalized = { role, content: [{ type: 'text', text }] }
        // DSH 的 assistant 历史消息必须带 source（kind/provider/model）。
        // 手机只存纯文本，这里按当前请求补一个 provider-neutral 的 source，
        // 走 foreignAssistant 回放，避免第二轮对话报 replayState 错误。
        if (role === 'assistant') {
          const rawSource = item.source
          normalized.source = rawSource && typeof rawSource === 'object' && !Array.isArray(rawSource)
            ? rawSource
            : { kind: 'model', provider, model }
        }
        messages.push(normalized)
      }
      if (messages.length === 0) {
        send({ kind: 'chat-error', requestId, message: 'chat requires non-empty messages' })
        return
      }
      if (typeof ctx.llm?.stream !== 'function') {
        send({ kind: 'chat-error', requestId, message: 'host LLM service is unavailable' })
        return
      }
      const previous = chatControllers.get(requestId)
      if (previous) previous.abort()
      const controller = new AbortController()
      chatControllers.set(requestId, controller)
      const reply = []
      let usage = null
      const startedAt = Date.now()
      send({ kind: 'chat-start', requestId, provider, model })
      try {
        for await (const chunk of ctx.llm.stream({
          provider,
          model,
          messages,
          signal: controller.signal,
        })) {
          const type = chunk?.type
          if (type === 'text-delta' && typeof chunk.text === 'string') {
            reply.push(chunk.text)
            send({ kind: 'chat-delta', requestId, text: chunk.text })
            continue
          }
          if (type === 'text' && typeof chunk.text === 'string' && chunk.blockType !== 'reasoning') {
            reply.push(chunk.text)
            send({ kind: 'chat-delta', requestId, text: chunk.text })
            continue
          }
          if (type === 'usage' && chunk.usage) {
            usage = chunk.usage
            continue
          }
          if (type === 'finish') {
            const reason = chunk.reason
            if (reason && reason.kind === 'error') {
              throw new Error(reason.failure?.message || 'model request failed')
            }
          }
        }
        send({
          kind: 'chat-done',
          requestId,
          text: reply.join(''),
          usage,
          elapsedMs: Date.now() - startedAt,
        })
        if (msg.store === true) {
          const safeId = String(msg.chatId || requestId)
            .replace(/[^A-Za-z0-9._-]/g, '_')
            .slice(0, 80)
          try {
            await fs.promises.mkdir(chatLogDir, { recursive: true })
            await fs.promises.appendFile(
              path.join(chatLogDir, `${safeId}.jsonl`),
              JSON.stringify({
                at: Date.now(),
                chatId: safeId,
                provider,
                model,
                messages,
                reply: reply.join(''),
                usage,
              }) + '\n',
            )
          } catch (error) {
            log(`chat log write failed: ${error && error.message ? error.message : error}`)
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          send({ kind: 'chat-cancelled', requestId })
        } else {
          send({
            kind: 'chat-error',
            requestId,
            message: error && error.message ? error.message : String(error),
          })
        }
      } finally {
        if (chatControllers.get(requestId) === controller) {
          chatControllers.delete(requestId)
        }
      }
    }

    const sendHostState = async (send) => {
      try {
        send(await readAccountFrame(api))
      } catch (error) {
        log(`account profile failed: ${error && error.message ? error.message : error}`)
        send({ kind: 'account-profile', signedIn: false, profile: null, balances: [], bonusWallets: [], accountState: 'unavailable' })
      }
      try {
        send(await readAccountModelsFrame(api))
      } catch (error) {
        log(`account model sync failed: ${error && error.message ? error.message : error}`)
        send({ kind: 'account-models', groups: [] })
      }
      if (options.syncCredentials === false) return
      try {
        send(await readCredentialsFrame(api, ctx.get('credentials')))
      } catch (error) {
        log(`credential sync failed: ${error && error.message ? error.message : error}`)
        send({ kind: 'api-credential', credentials: [], error: 'credential-sync-failed' })
      }
    }

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 4 * 1024 * 1024,
      // Secrets travel in requested subprotocols; never echo them back.
      handleProtocols(protocols) {
        return protocols.has('dsh-mobile-v1') ? 'dsh-mobile-v1' : false
      },
    })
    // An unhandled 'error' on a server/socket crashes the Electron main process:
    // always keep a listener so a misbehaving phone can never take DSH down.
    wss.on('error', (error) => log(`websocket server error: ${error && error.message ? error.message : error}`))

    const broadcast = (frame) => {
      for (const client of clients) {
        if (client.readyState !== 1) continue
        try {
          client.send(stringifyWireFrame(frame))
        } catch (error) {
          log(`broadcast failed: ${error && error.message ? error.message : error}`)
        }
      }
    }

    const refreshArchives = async () => {
      try {
        const value = await api.workspace.list({})
        if (!Array.isArray(value?.archivedSessionIds)) return
        archivedSessionIds = value.archivedSessionIds.map(String)
        broadcast({ kind: 'session-archives', archivedSessionIds })
      } catch (error) {
        log(`archived session refresh failed: ${error.message}`)
      }
    }

    const setup = (ws, device, pairingToken, port) => {
      clients.add(ws)
      registry.connected(device.id)
      const send = (frame) => {
        if (ws.readyState !== 1) return
        try {
          ws.send(stringifyWireFrame(frame))
        } catch (error) {
          log(`send failed: ${error && error.message ? error.message : error}`)
        }
      }
      ws.on('error', (error) => log(`client socket error: ${error && error.message ? error.message : error}`))
      log(`client connected: ${device.name} (${device.id})`)
      ws.deviceId = device.id

      if (pairingToken) {
        send({ kind: 'paired', token: pairingToken, device: { id: device.id, name: device.name } })
      }
      send({
        kind: 'hello',
        protocol: PROTOCOL_REVISION,
        capabilities: [
          'session-rename',
          'session-archive',
          'plugin-management-v1',
          'assistant-stream-v1',
          'history-format-version',
          'gateway-identity',
          'account-profile-v1',
          'account-models-v1',
          'credential-sync-v1',
          'model-selection-v1',
          'chat-completion-v1',
        ],
        authenticated: true,
        gatewayId,
        gatewayName,
        device: { id: device.id, name: device.name },
        port,
        clients: clients.size,
      })
      if (archivedSessionIds !== null) {
        send({ kind: 'session-archives', archivedSessionIds })
      }
      // 账号与凭据读取要经过 Host 服务，不能阻塞 hello：异步补发。
      void sendHostState(send)

      // 每个订阅记住是否已经拿到过历史快照：follow 打不开（例如正在跑的会话
      // 或格式不支持的会话）时必须退回到直接读历史，否则手机端会是一片空白。
      const subscriptions = new Map()

      const projectEvents = (sessionId, historyEvents) => {
        // Project history events the same way as live events: the app only
        // renders `{type, text, seq}`, raw DSH events keep text inside
        // `data.content` blocks and would show up as an empty conversation.
        const projected = []
        for (const entry of historyEvents || []) {
          const wired = wireEvent(sessionId, entry.event)
          if (wired) projected.push({ ...wired.event, seq: entry.event.seq, time: entry.event.time })
        }
        return projected.length > SNAPSHOT_MAX_EVENTS
          ? projected.slice(-SNAPSHOT_MAX_EVENTS)
          : projected
      }

      // 子会话（subagent）必须带上父地址，否则 Host 会拒绝读取：
      // "subagent Sessions require their durable parent address"。
      const sendHistorySnapshot = async (sessionId, subscriptionId, target = {}) => {
        const snapshot = await api.sessions.history({ ...target, sessionId, maxMessages: 40 })
        const state = subscriptions.get(subscriptionId)
        if (state) state.snapshot = true
        send({
          kind: 'session-snapshot',
          sessionId,
          subscriptionId,
          events: projectEvents(sessionId, snapshot && snapshot.events),
          assistantStream: { revision: 0 },
          replace: true,
        })
      }

      const follower = createSessionFollower(api, {
        onFrame(frame, context) {
          const state = subscriptions.get(context.subscriptionId)
          if (state) state.lastError = null
          if (frame.type === 'snapshot') {
            if (state) state.snapshot = true
            send({
              kind: 'session-snapshot',
              sessionId: context.sessionId,
              subscriptionId: context.subscriptionId,
              events: projectEvents(context.sessionId, frame.history.events),
              assistantStream: frame.assistantStream,
              replace: true,
            })
          } else if (frame.type === 'event') {
            const wire = wireEvent(context.sessionId, frame.event)
            if (wire) send({ ...wire, subscriptionId: context.subscriptionId })
          } else {
            // 手机端只会渲染 text-delta；把思考增量按正文下发，否则只有
            // reasoning 的回合在流式过程中一片空白。
            const chunk = frame.frame && frame.frame.chunk
            const wireFrame = chunk && chunk.type === 'reasoning-delta'
              ? { ...frame.frame, chunk: { ...chunk, type: 'text-delta' } }
              : frame.frame
            send({
              kind: 'assistant-stream',
              sessionId: context.sessionId,
              subscriptionId: context.subscriptionId,
              frame: wireFrame,
            })
          }
        },
        onError(error, context) {
          const state = subscriptions.get(context.subscriptionId)
          const code = error.code || 'stream-interrupted'
          // 同一个订阅上连续重试失败不要反复刷重置帧，只在错误类型变化时通知一次。
          if (!state || state.lastError !== code) {
            send({
              kind: 'session-stream-reset',
              sessionId: context.sessionId,
              subscriptionId: context.subscriptionId,
              code,
              message: error.message,
            })
          }
          if (state) state.lastError = code
          if (state && !state.snapshot) {
            state.snapshot = true
            sendHistorySnapshot(context.sessionId, context.subscriptionId, context)
              .catch((historyError) => log(`history fallback failed: ${historyError && historyError.message ? historyError.message : historyError}`))
          }
        },
      })

      ws.on('message', (data) => {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          send({ kind: 'error', message: 'invalid json' })
          return
        }
        if (!msg || typeof msg.type !== 'string') return
        void (async () => {
          try {
            if (msg.type === 'ping') {
              send({ kind: 'pong', at: Date.now() })
              return
            }
            if (msg.type === 'sessions') {
              send(await listSessions(api))
              return
            }
            if (msg.type === 'subscribe') {
              const target = parseSessionTarget(msg, { optional: true })
              if (target.error) {
                send(target.error)
                return
              }
              follower.stop()
              // 旧订阅的记账一并丢弃，Map 不能随每次 subscribe 无限增长。
              subscriptions.clear()
              const sessionId = target.value.sessionId
              const streaming = msg.assistantStream === true && !!sessionId
              const subscriptionId = crypto.randomUUID()
              subscriptions.set(subscriptionId, { snapshot: false, lastError: null })
              send({
                kind: 'subscribed',
                ...target.value,
                sessionId: sessionId || null,
                subscriptionId,
                assistantStream: streaming,
              })
              if (streaming) {
                follower.start(sessionId, subscriptionId, target.value)
                  .catch((error) => log(`follow task failed: ${error && error.message ? error.message : error}`))
              }
              // 打开会话时顺带下发模型目录与当前选择，手机端不用再等一次往返。
              if (sessionId) {
                readModelsFrame(api, sessionId)
                  .then((frame) => send(frame))
                  .catch((error) => log(`models failed: ${error && error.message ? error.message : error}`))
              }
              return
            }
            if (msg.type === 'unsubscribe') {
              follower.stop()
              send({ kind: 'subscribed', sessionId: null, assistantStream: false })
              return
            }
            if (msg.type === 'chat') {
              void runChat(msg, send)
              return
            }
            if (msg.type === 'chat-cancel') {
              const requestId = typeof msg.requestId === 'string' ? msg.requestId.trim() : ''
              if (requestId) chatControllers.get(requestId)?.abort()
              return
            }
            if (msg.type === 'message') {
              send(await admitMessage(api, msg))
              return
            }
            if (msg.type === 'session-stats') {
              const target = parseSessionTarget(msg, { optional: false })
              if (target.error) {
                send(target.error)
                return
              }
              send(await statsFrame(api, target.value))
              return
            }
            if (msg.type === 'host-state') {
              await sendHostState(send)
              return
            }
            if (msg.type === 'models') {
              const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim()
                ? msg.sessionId.trim() : null
              send(await readModelsFrame(api, sessionId))
              return
            }
            if (msg.type === 'model-select') {
              const sessionId = requireSessionId(msg)
              if (sessionId.error) {
                send(sessionId.error)
                return
              }
              const selection = modelSelectionOf(msg)
              if (!selection) {
                send({
                  kind: 'error',
                  code: 'bad-request',
                  requestType: 'model-select',
                  sessionId: sessionId.value,
                  message: 'model-select requires provider and model',
                })
                return
              }
              const result = await api.sessions.selectModel({ sessionId: sessionId.value, ...selection })
              const selected = result?.selected ?? selection
              broadcast({ kind: 'model-selected', sessionId: sessionId.value, selected })
              return
            }
            if (msg.type === 'session-rename') {
              const sessionId = requireSessionId(msg)
              if (sessionId.error) {
                send(sessionId.error)
                return
              }
              const title = typeof msg.title === 'string' ? msg.title.trim() : ''
              if (!title) {
                send({ kind: 'error', code: 'bad-request', requestType: 'session-rename', sessionId: sessionId.value, message: 'session-rename requires a non-empty title' })
                return
              }
              await api.sessions.rename({ sessionId: sessionId.value, title })
              broadcast({ kind: 'session-title-changed', sessionId: sessionId.value, title })
              return
            }
            if (msg.type === 'session-archive') {
              const sessionId = requireSessionId(msg)
              if (sessionId.error) {
                send(sessionId.error)
                return
              }
              await api.workspace.archiveSession({ sessionId: sessionId.value })
              await refreshArchives()
              send({
                kind: 'session-archived',
                sessionId: sessionId.value,
                archivedSessionIds: archivedSessionIds || [],
              })
              return
            }
            if (PLUGIN_REQUEST_TYPES.has(msg.type)) {
              const frame = await handlePluginQuery(api, msg)
              if (frame) send(frame)
              return
            }
            send({
              kind: 'error',
              code: 'unsupported',
              requestType: msg.type,
              message: `unsupported request: ${msg.type}`,
            })
          } catch (error) {
            log(`request ${msg.type} failed: ${error && error.message ? error.message : error}`)
            send({
              kind: 'error',
              code: (error && error.code) || 'internal',
              requestType: msg.type,
              ...(typeof msg.sessionId === 'string' ? { sessionId: msg.sessionId } : {}),
              ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
              message: error && error.message ? error.message : String(error),
            })
          }
        })()
      })

      ws.on('close', (code) => {
        follower.stop()
        for (const controller of chatControllers.values()) controller.abort()
        chatControllers.clear()
        clients.delete(ws)
        registry.disconnected(device.id)
        log(`client disconnected: ${device.name} code=${code}`)
      })
    }

    const handleUpgrade = (req, socket, head, port) => {
      let pathname
      try {
        pathname = new URL(req.url || '/', 'http://gateway.invalid').pathname
      } catch {
        rejectUpgrade(socket, 400, 'invalid WebSocket path')
        return
      }
      if (pathname !== wsPath) {
        rejectUpgrade(socket, 404, 'not found')
        return
      }
      const protocols = requestedProtocols(req)
      const credential = credentialOf(req, protocols)
      let device
      let pairingToken
      if (credential && credential.kind === 'pair') {
        const claimed = registry.claimPairing(
          credential.value,
          deviceIdOf(protocols),
          deviceNameOf(protocols),
        )
        if (claimed) {
          device = claimed.device
          pairingToken = claimed.token
        }
      } else if (credential && credential.kind === 'token') {
        device = registry.authenticate(credential.value, deviceIdOf(protocols), deviceNameOf(protocols))
      }
      if (!device) {
        rejectUpgrade(socket, 401, 'missing or invalid device credential')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => setup(ws, device, pairingToken, port))
    }

    // ---- local admin page (loopback only) ----
    const handleAdmin = async (req, res) => {
      if (!isLoopback(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const sendJson = (status, value) => {
        const body = JSON.stringify(value)
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
      }
      const url = new URL(req.url || '/', 'http://x')
      if (req.method === 'GET' && url.pathname === '/mobile-link') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(htmlPage())
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/status') {
        sendJson(200, {
          gatewayId,
          gatewayName,
          port: boundPort,
          endpoints: lanEndpoints(boundPort, wsPath),
          devices: registry.list(),
          clients: clients.size,
          syncCredentials: options.syncCredentials !== false,
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/host-state') {
        try {
          const account = await readAccountFrame(api)
          const synced = options.syncCredentials === false
            ? { credentials: [] }
            : await readCredentialsFrame(api, ctx.get('credentials'))
          sendJson(200, {
            account,
            credentials: (synced.credentials || []).map(item => ({
              provider: item.provider,
              displayName: item.displayName,
              baseUrl: item.baseUrl,
              api: item.api,
              hasKey: true,
              last4: item.last4,
              models: (item.models || []).map(model => model.id),
              defaultModel: item.defaultModel,
            })),
            defaultProvider: synced.defaultProvider ?? null,
          })
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/chat') {
        try {
          const provider = url.searchParams.get('provider') || 'opencode2dsh'
          const model = url.searchParams.get('model') || 'deepseek-v4.1-flash-free'
          const text = url.searchParams.get('text') || 'ping'
          const chunks = []
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 20000)
          try {
            for await (const chunk of ctx.llm.stream({
              provider,
              model,
              messages: [{ role: 'user', content: [{ type: 'text', text }] }],
              signal: controller.signal,
            })) {
              chunks.push({
                type: chunk?.type,
                keys: chunk && typeof chunk === 'object' ? Object.keys(chunk) : [],
                text: typeof chunk?.text === 'string' ? chunk.text : null,
                raw: JSON.stringify(chunk).slice(0, 500),
              })
              if (chunks.length > 80) break
            }
          } finally {
            clearTimeout(timer)
            controller.abort()
          }
          sendJson(200, { provider, model, chunks })
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/llm') {
        try {
          const providers = typeof ctx.llm?.listProviders === 'function'
            ? ctx.llm.listProviders().map(provider => ({
                id: provider.id,
                name: provider.name,
              }))
            : []
          sendJson(200, {
            hasLlm: Boolean(ctx.llm),
            hasStream: typeof ctx.llm?.stream === 'function',
            providers,
          })
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/history') {
        try {
          let sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) {
            const listed = await api.sessions.list({})
            const items = Array.isArray(listed?.items) ? listed.items : []
            sessionId = items.length > 0 ? String(items[0].sessionId || items[0].id || '') : ''
          }
          if (!sessionId) {
            sendJson(400, { message: 'no session available' })
            return
          }
          const max = Math.min(Number(url.searchParams.get('max')) || 120, 300)
          const history = await api.sessions.history({ sessionId, maxMessages: max })
          const events = Array.isArray(history?.events) ? history.events : []
          if (url.searchParams.get('raw') === '1') {
            sendJson(200, { sessionId, events: events.map(item => item?.event ?? item) })
            return
          }
          const counts = {}
          const samples = {}
          for (const item of events) {
            const event = item?.event ?? item
            const type = event?.type || '?'
            counts[type] = (counts[type] || 0) + 1
            if (!samples[type] && samples[type] !== '') {
              samples[type] = JSON.stringify(event).slice(0, 900)
            }
          }
          sendJson(200, { sessionId, counts, samples })
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/presets') {
        try {
          sendJson(200, await api.agentPresets.list())
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/preset') {
        try {
          const id = url.searchParams.get('id') || 'minimal'
          sendJson(200, await api.agentPresets.read(id))
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/models') {
        try {
          sendJson(200, await readModelsFrame(api))
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/sessions') {
        try {
          sendJson(200, await api.sessions.list({}))
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/mobile-link/debug/history') {
        try {
          const sessionId = url.searchParams.get('sessionId') || ''
          const maxMessages = Number(url.searchParams.get('maxMessages') || '40')
          const snapshot = await api.sessions.history({ sessionId, maxMessages })
          sendJson(200, snapshot)
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/mobile-link/pair') {
        try {
          const { raw, body } = pairingPayload({
            registry,
            gatewayId,
            gatewayName,
            port: boundPort,
            wsPath,
          })
          const qr = await QRCode.toDataURL(raw, { margin: 1, width: 480 })
          sendJson(200, { raw, payload: body, qr })
        } catch (error) {
          sendJson(500, { message: error.message })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/mobile-link/revoke') {
        let body = ''
        for await (const chunk of req) body += chunk
        try {
          const value = JSON.parse(body || '{}')
          const removed = registry.revoke(String(value.id || ''))
          sendJson(removed ? 200 : 404, { removed })
        } catch {
          sendJson(400, { message: 'invalid body' })
        }
        return
      }
      sendJson(404, { message: 'not found' })
    }

    const disposeAdmin = ctx.webServer.register({
      kind: 'prefix',
      path: '/mobile-link',
      handler(req, res) {
        handleAdmin(req, res).catch((error) => {
          log(`web admin request failed: ${error && error.message ? error.message : error}`)
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('internal error')
        })
      },
    })

    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: wsPath,
      handler(req, socket, head) {
        try {
          handleUpgrade(req, socket, head, ctx.webServer.port)
        } catch (error) {
          log(`web upgrade failed: ${error && error.message ? error.message : error}`)
          rejectUpgrade(socket, 500, 'internal error')
        }
      },
    })

    // ---- dedicated LAN listener: the mobile WebSocket plus a loopback admin page ----
    const lanServer = http.createServer((req, res) => {
      if (isLoopback(req) && (req.url || '').startsWith('/mobile-link')) {
        handleAdmin(req, res).catch((error) => {
          log(`admin request failed: ${error && error.message ? error.message : error}`)
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('internal error')
        })
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })
    lanServer.on('upgrade', (req, socket, head) => {
      let pathname
      try {
        pathname = new URL(req.url || '/', 'http://lan.invalid').pathname
      } catch {
        rejectUpgrade(socket, 400, 'invalid WebSocket path')
        return
      }
      if (pathname !== wsPath) {
        rejectUpgrade(socket, 404, 'not found')
        return
      }
      const remote = req.socket && req.socket.remoteAddress
      if (!remote || !/^(127\.|::1|::ffff:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(remote)) {
        rejectUpgrade(socket, 403, 'LAN listener accepts private-network clients only')
        return
      }
      try {
        handleUpgrade(req, socket, head, boundPort)
      } catch (error) {
        log(`LAN upgrade failed: ${error && error.message ? error.message : error}`)
        rejectUpgrade(socket, 500, 'internal error')
      }
    })
    lanServer.on('error', (error) => {
      log(`LAN listener failed on ${options.lanHost}:${boundPort}: ${error.message}`)
    })
    lanServer.on('close', () => log(`LAN listener closed (port ${boundPort})`))
    lanServer.listen(options.lanPort, options.lanHost, () => {
      const address = lanServer.address()
      boundPort = typeof address === 'object' && address ? address.port : options.lanPort
      log(`LAN listener ready on ${options.lanHost}:${boundPort}${wsPath} (${lanEndpoints(boundPort, wsPath).join(', ') || 'no private IPv4 found'})`)
    })

    // ---- title changes from any surface (WebUI, mobile) ----
    const disposeEvents = ctx.on('session/event', (session, event) => {
      if (!clients.size) return
      if (event.type === 'session/title' && typeof event.data?.title === 'string') {
        broadcast({
          kind: 'session-title-changed',
          sessionId: String(session.id),
          title: event.data.title,
          seq: event.seq,
          time: event.time,
        })
      }
    })

    void refreshArchives()

    ctx.on('dispose', () => {
      try {
        for (const client of clients) client.close(1001, 'gateway closed')
        clients.clear()
        wss.close()
        lanServer.close()
        disposeAdmin()
        disposeUpgrade()
        disposeEvents()
      } catch (error) {
        log(`dispose failed: ${error && error.message ? error.message : error}`)
      }
      log('mobile-link disposed')
    })
}

export default plugin
