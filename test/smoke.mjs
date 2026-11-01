// Standalone smoke test: pairing + hello without a live DSH host.
import http from 'node:http'
import WebSocket from 'ws'

import plugin from '../lib/index.mjs'

const routes = []
const upgrades = []
const webServer = {
  port: 3999,
  register(route) {
    routes.push(route)
    return () => {}
  },
  registerUpgrade(route) {
    upgrades.push(route)
    return () => {}
  },
}
const controller = new AbortController()
const ctx = {
  webServer,
  connection: { createPeer: () => ({ signal: controller.signal }) },
  typertGateway: {
    invoke: async () => ({}),
    stream: async () => ({}),
  },
  on: () => () => {},
}
plugin.apply(ctx, { lanPort: 0, gatewayName: 'Smoke PC' })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function call(route, req) {
  return new Promise((resolve) => {
    const chunks = []
    const res = {
      writeHead(status, headers) {
        res.status = status
        res.headers = headers
      },
      end(body) {
        chunks.push(body)
        resolve({ status: res.status, body: chunks.join('') })
      },
    }
    route.handler(req, res)
  })
}

await wait(300)
const pairResponse = await call(routes[0], {
  method: 'POST',
  url: '/mobile-link/pair',
  socket: { remoteAddress: '127.0.0.1' },
})
const pair = JSON.parse(pairResponse.body)
console.log('pair status:', pairResponse.status, 'qr bytes:', (pair.qr || '').length, 'endpoints:', pair.payload.endpoints)

const lan = await new Promise((resolve) => {
  const started = Date.now()
  const tick = () => {
    if (routes.length) {
      // boundPort is private; discover it from the status route instead.
      call(routes[0], { method: 'GET', url: '/mobile-link/status', socket: { remoteAddress: '127.0.0.1' } })
        .then((result) => {
          const status = JSON.parse(result.body)
          if (status.port) resolve(status.port)
          else setTimeout(tick, 50)
        })
      return
    }
    if (Date.now() - started > 3000) resolve(0)
    setTimeout(tick, 50)
  }
  tick()
})
console.log('bound port:', lan)

const url = `ws://127.0.0.1:${lan}/ws/mobile`
const ws = new WebSocket(url, [
  'dsh-mobile-v1',
  `dsh-pair.${pair.payload.pairingCode}`,
  'dsh-device.smoke-device-001',
  `dsh-device-name.${Buffer.from('Smoke Tablet').toString('base64url')}`,
])
const frames = []
ws.on('message', (data) => {
  frames.push(JSON.parse(data.toString()))
})
ws.on('error', (error) => console.error('ws error:', error.message)
)
await new Promise((resolve) => {
  ws.on('open', resolve)
  setTimeout(resolve, 2000)
})
await wait(300)
console.log('frames:', frames.map((frame) => frame.kind).join(', '))
console.log('paired token length:', frames.find((frame) => frame.kind === 'paired')?.token?.length)
console.log('hello protocol:', frames.find((frame) => frame.kind === 'hello')?.protocol)
ws.close()
process.exit(0)
