/**
 * Lets an assistant such as Claude work on the open project, over the Model
 * Context Protocol. When the user switches it on, the app listens on this
 * computer only (127.0.0.1) for a client that knows its token, offers the
 * tools of src/shared/mcp.ts, and passes each call to the window to carry out.
 *
 * The protocol is spoken in its simplest form: every request is an HTTP POST
 * of JSON-RPC to /mcp, answered with JSON. Nothing is streamed and no session
 * is kept, so a client can come and go as it likes.
 */
import { app, clipboard, dialog, ipcMain, type BrowserWindow } from 'electron'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { APP_NAME } from '@shared/menu'
import { MCP_INSTRUCTIONS, MCP_TOOLS, type McpAnswer, type McpStatus } from '@shared/mcp'

/** Fixed, so that a client set up once keeps working. */
const PORT = 47821
const HOST = '127.0.0.1'
/** The versions of the protocol this speaks, newest first. */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 4 * 1024 * 1024
/** How long the window is given to carry out a call. */
const CALL_TIMEOUT = 30_000

interface Settings {
  enabled: boolean
  token: string
}

const settingsPath = (): string => join(app.getPath('userData'), 'mcp.json')
let settings: Settings = { enabled: false, token: '' }
let server: Server | null = null
let problem: string | null = null
let getWindow: () => BrowserWindow | null = () => null

const waiting = new Map<number, (answer: McpAnswer) => void>()
let lastCall = 0

const address = (): string => `http://${HOST}:${PORT}/mcp`

export function mcpStatus(): McpStatus {
  return { enabled: settings.enabled, problem, address: address(), token: settings.token }
}

/** The line that connects Claude Code to this app. */
export function mcpCommand(): string {
  return `claude mcp add --transport http mtstudio ${address()} --header "Authorization: Bearer ${settings.token}"`
}

async function save(): Promise<void> {
  // The token is what lets a program in, so only this user may read the file.
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/** Passes a call to the window and waits for its answer. */
function callWindow(name: string, args: unknown): Promise<McpAnswer> {
  const window = getWindow()
  if (!window || window.isDestroyed()) return Promise.resolve({ ok: false, error: `${APP_NAME}'s window is not open.` })
  const id = ++lastCall
  return new Promise<McpAnswer>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      resolve({ ok: false, error: `${APP_NAME} did not answer in time.` })
    }, CALL_TIMEOUT)
    waiting.set(id, (answer) => {
      clearTimeout(timer)
      resolve(answer)
    })
    window.webContents.send('mcp:call', { id, name, args })
  })
}

interface Rpc {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

const failure = (id: unknown, code: number, message: string): unknown => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

/** Answers one JSON-RPC message; null for a notification, which gets no answer. */
async function answer(message: Rpc): Promise<unknown | null> {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(message?.id, -32600, 'Not a JSON-RPC 2.0 request.')
  const notification = message.id === undefined || message.id === null
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>
  const result = (value: unknown): unknown => ({ jsonrpc: '2.0', id: message.id, result: value })

  if (message.method.startsWith('notifications/')) return null
  if (notification) return null
  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return result({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: APP_NAME, version: app.getVersion() },
        instructions: MCP_INSTRUCTIONS
      })
    }
    case 'ping':
      return result({})
    case 'tools/list':
      return result({ tools: MCP_TOOLS })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!MCP_TOOLS.some((tool) => tool.name === name)) return failure(message.id, -32602, `Unknown tool: ${name}`)
      const outcome = await callWindow(name, params.arguments)
      // A tool that could not do what was asked says so in its result, where the assistant reads it.
      return result(outcome.ok ? { content: [{ type: 'text', text: JSON.stringify(outcome.value) }] } : { content: [{ type: 'text', text: outcome.error }], isError: true })
    }
    default:
      return failure(message.id, -32601, `Method not found: ${message.method}`)
  }
}

function allowed(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const wanted = Buffer.from(settings.token)
  return wanted.length > 0 && given.length === wanted.length && timingSafeEqual(given, wanted)
}

function reply(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  response.writeHead(status, { ...(text ? { 'Content-Type': 'application/json' } : {}), 'Content-Length': Buffer.byteLength(text), ...headers })
  response.end(text)
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // A web page must never be able to reach this: browsers name the page a request comes from, and real clients do not.
  if (request.headers.origin) return reply(response, 403, { error: 'Requests from web pages are refused.' })
  // Nor a name that merely resolves to this computer.
  if (request.headers.host !== `${HOST}:${PORT}` && request.headers.host !== `localhost:${PORT}`) return reply(response, 403, { error: 'Unknown host.' })
  if ((request.url ?? '').split('?')[0] !== '/mcp') return reply(response, 404, { error: 'Not found.' })
  if (!allowed(request)) return reply(response, 401, { error: `A token is needed. ${APP_NAME} shows it under Assistant in its menu.` }, { 'WWW-Authenticate': 'Bearer' })
  if (request.method !== 'POST') return reply(response, 405, { error: 'Send requests by POST.' }, { Allow: 'POST' })

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) return reply(response, 413, { error: 'Too much was sent.' })
    chunks.push(chunk as Buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return reply(response, 400, failure(null, -32700, 'That is not JSON.'))
  }
  if (Array.isArray(body)) {
    const answers: unknown[] = []
    // In turn, so that a batch of edits lands in the order it was written.
    for (const each of body) {
      const one = await answer(each as Rpc)
      if (one) answers.push(one)
    }
    return answers.length ? reply(response, 200, answers) : reply(response, 202)
  }
  const one = await answer(body as Rpc)
  return one ? reply(response, 200, one) : reply(response, 202)
}

function listen(): Promise<void> {
  return new Promise((resolve) => {
    const next = createServer((request, response) => {
      handle(request, response).catch((error) => {
        console.error('[mcp]', error)
        if (!response.headersSent) reply(response, 500, { error: 'Something went wrong.' })
        else response.end()
      })
    })
    next.once('error', (error: NodeJS.ErrnoException) => {
      problem =
        error.code === 'EADDRINUSE'
          ? `Something else on this computer is already using port ${PORT}, perhaps another copy of ${APP_NAME}.`
          : `The connection could not be opened: ${error.message}`
      server = null
      resolve()
    })
    next.listen(PORT, HOST, () => {
      problem = null
      server = next
      resolve()
    })
  })
}

async function close(): Promise<void> {
  const open = server
  server = null
  problem = null
  if (open) {
    open.closeAllConnections()
    await new Promise<void>((resolve) => open.close(() => resolve()))
  }
}

async function setEnabled(enabled: boolean): Promise<void> {
  settings.enabled = enabled
  if (enabled && !settings.token) settings.token = randomBytes(24).toString('base64url')
  await save()
  await close()
  if (enabled) await listen()
}

/** Reads the setting and, if assistant access was left on, starts listening. `window` says where calls go. */
export async function startMcp(window: () => BrowserWindow | null): Promise<void> {
  getWindow = window
  ipcMain.on('mcp:answer', (event, id: number, given: McpAnswer) => {
    // Only the app's own window answers.
    if (event.sender !== getWindow()?.webContents) return
    const resolve = waiting.get(id)
    waiting.delete(id)
    resolve?.(given && typeof given === 'object' && 'ok' in given ? given : { ok: false, error: `${APP_NAME} gave no answer.` })
  })
  const read = await readFile(settingsPath(), 'utf8').catch(() => null)
  if (read) {
    try {
      const stored = JSON.parse(read) as Partial<Settings>
      settings = { enabled: stored.enabled === true, token: typeof stored.token === 'string' ? stored.token : '' }
    } catch {
      // A file that cannot be read is as good as none: access stays off.
    }
  }
  if (settings.enabled && settings.token) await listen()
  app.on('before-quit', () => void close())
}

/** The Assistant menu's one item: says whether access is on, and switches it, copies the line that connects Claude Code, or makes a new token. */
export async function showMcpDialog(): Promise<void> {
  for (;;) {
    const { enabled } = settings
    const window = getWindow()
    const listening = enabled && !problem
    const buttons = listening ? ['Copy Command for Claude Code', 'New Token', 'Turn Off', 'Close'] : [enabled ? 'Try Again' : 'Turn On', ...(enabled ? ['Turn Off'] : []), 'Close']
    const detail = listening
      ? `An assistant that knows the token below can read and change the project open in ${APP_NAME}: its tracks, clips, notes, tempo and key, and the transport. Every change it makes can be undone with Edit › Undo. It cannot reach your files.\n\n` +
        `Only programs on this computer can connect.\n\nAddress: ${address()}\nToken: ${settings.token}\n\n` +
        `To connect Claude Code, copy the command and run it in a terminal. For other assistants, give them the address, and the token as an "Authorization: Bearer" header.`
      : enabled
        ? `Assistant access is switched on, but ${APP_NAME} is not listening. ${problem}`
        : `Switch this on to let an assistant such as Claude read and change the project open in ${APP_NAME}: its tracks, clips, notes, tempo and key, and the transport.\n\n` +
          `Only programs on this computer that know a token can connect, every change can be undone, and your files stay out of reach. It stays on until you turn it off.`
    const options = {
      type: 'none' as const,
      message: listening ? 'Assistant access is on' : enabled ? 'Assistant access could not start' : 'Assistant access is off',
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1
    }
    const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    const chosen = buttons[response]
    if (chosen === 'Copy Command for Claude Code') {
      clipboard.writeText(mcpCommand())
      return
    }
    if (chosen === 'New Token') {
      // Anything connected with the old one is shut out.
      settings.token = randomBytes(24).toString('base64url')
      await setEnabled(true)
    } else if (chosen === 'Turn On' || chosen === 'Try Again') await setEnabled(true)
    else if (chosen === 'Turn Off') await setEnabled(false)
    else return
  }
}
