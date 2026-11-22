// Amazon Quick chat client for Cloudflare Workers.
// Port of the wire protocol used by magpie-aws-quick (lib/quickws.mjs), one socket per turn:
//   URL: wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream?surfaceType=…&token=<id_token>&workingSessionId=…&channel=prod
//   out: binary frame = JSON {"eventType":"rawInputEvent","payload":{"payload":base64(JSON {type,payload})}}
//   in:  AWS event-stream frames; :event-type=rawOutputEvent; body JSON {"payload": base64(JSON {type,thread_id,payload})}
// Workers can't open wss:// directly, so we fetch https:// with an Upgrade header and call accept().
import type { QuickSession } from './accounts'
import { b64decode, b64encode } from './crypto'

export type AgentMode = 'fast' | 'balanced' | 'smart' | 'advanced'
export type Effort = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface TurnInput {
  text: string
  systemPrompt: string
  mode: AgentMode
  effort: Effort
  webSearch: boolean
}

export type QuickErrorKind = 'auth' | 'ws' | 'stream' | 'timeout'

export class QuickError extends Error {
  kind: QuickErrorKind
  constructor(message: string, kind: QuickErrorKind) {
    super(message)
    this.name = 'QuickError'
    this.kind = kind
  }
}

export interface InnerEvent {
  type: string
  thread_id?: string
  payload?: Record<string, any>
  message?: string
}

const SURFACE = 'QUICK_WORK_DESKTOP_WINDOWS'
const APP_VERSION = '1.2.4660'
const SESSION_ACK_MS = 8_000
const IDLE_MS = 90_000
/** Hard cap on one whole turn: idle timeouts reset on every event, so a slow trickle could otherwise hang a request. */
const TURN_DEADLINE_MS = 240_000
// Quick's own timezone/locale fields. The gateway has no per-request timezone,
// so UTC is used.
const USER_TZ = 'UTC'
const USER_LOCALE = 'en-US'

const te = new TextEncoder()
const td = new TextDecoder()

// ---- AWS event-stream framing (no CRC check; the transport is TLS) ----
const HV = { BOOL_TRUE: 0, BOOL_FALSE: 1, BYTE: 2, SHORT: 3, INT: 4, LONG: 5, BYTES: 6, STRING: 7, TIMESTAMP: 8, UUID: 9 }

interface EsMessage {
  headers: Record<string, string | number | boolean | Uint8Array>
  payload: Uint8Array
}

export function esDrain(buf: Uint8Array): { messages: EsMessage[]; consumed: number } {
  const messages: EsMessage[] = []
  let pos = 0
  while (pos + 16 <= buf.length) {
    const view = new DataView(buf.buffer, buf.byteOffset + pos, buf.length - pos)
    const totalLen = view.getUint32(0, false)
    if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
      pos += 1
      continue
    }
    if (pos + totalLen > buf.length) break
    const headersLen = view.getUint32(4, false)
    const hend = pos + 12 + headersLen
    const headers: EsMessage['headers'] = {}
    try {
      let j = pos + 12
      while (j < hend) {
        const nl = buf[j++]
        const name = td.decode(buf.slice(j, j + nl))
        j += nl
        const vt = buf[j++]
        if (vt === HV.BOOL_TRUE) headers[name] = true
        else if (vt === HV.BOOL_FALSE) headers[name] = false
        else if (vt === HV.BYTE) {
          headers[name] = buf[j]
          j += 1
        } else if (vt === HV.SHORT) {
          headers[name] = (buf[j] << 8) | buf[j + 1]
          j += 2
        } else if (vt === HV.INT) {
          headers[name] = new DataView(buf.buffer, buf.byteOffset + j, 4).getUint32(0, false)
          j += 4
        } else if (vt === HV.LONG || vt === HV.TIMESTAMP) {
          let v = 0
          for (let k = 0; k < 8; k++) v = v * 256 + buf[j + k]
          headers[name] = v
          j += 8
        } else if (vt === HV.BYTES || vt === HV.STRING) {
          const l = (buf[j] << 8) | buf[j + 1]
          j += 2
          const raw = buf.slice(j, j + l)
          j += l
          headers[name] = vt === HV.STRING ? td.decode(raw) : raw
        } else if (vt === HV.UUID) {
          headers[name] = buf.slice(j, j + 16)
          j += 16
        } else break
      }
      messages.push({ headers, payload: buf.slice(hend, pos + totalLen - 4) })
    } catch {
      // malformed frame: skip it
    }
    pos += totalLen
  }
  return { messages, consumed: pos }
}

function wrapInput(inner: Record<string, unknown>): Uint8Array {
  const innerB64 = b64encode(te.encode(JSON.stringify(inner)))
  return te.encode(JSON.stringify({ eventType: 'rawInputEvent', payload: { payload: innerB64 } }))
}

/** Buffers socket frames and hands out decoded inner events in order. */
class Inbox {
  private items: InnerEvent[] = []
  private buf = new Uint8Array(0)
  private error: QuickError | null = null
  private wake: (() => void) | null = null
  // Diagnostics for timeout messages: what actually came back on the socket.
  private frames = 0
  private bytes = 0
  private seen: string[] = []

  private note(s: string): void {
    if (this.seen.length < 12 && !this.seen.includes(s)) this.seen.push(s)
  }

  summary(): string {
    return `${this.frames} frames, ${this.bytes} bytes${this.seen.length ? `, seen: ${this.seen.join(' ')}` : ''}`
  }

  frame(data: string | ArrayBuffer): void {
    this.frames += 1
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) this.note(`data:${Object.prototype.toString.call(data)}`)
    const chunk = typeof data === 'string' ? te.encode(data) : new Uint8Array(data)
    this.bytes += chunk.length
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    const { messages, consumed } = esDrain(merged)
    this.buf = merged.slice(consumed)
    for (const m of messages) this.onMessage(m)
  }

  private onMessage(m: EsMessage): void {
    const mt = m.headers[':message-type']
    this.note(`${String(mt)}/${String(m.headers[':event-type'] ?? m.headers[':exception-type'] ?? '')}`)
    if (mt === 'error' || mt === 'exception') {
      const msg = typeof m.headers[':error-message'] === 'string' ? (m.headers[':error-message'] as string) : td.decode(m.payload).slice(0, 300)
      this.push({ type: 'error', message: msg })
      return
    }
    if (m.headers[':event-type'] !== 'rawOutputEvent' || m.payload.length === 0) return
    try {
      const outer = JSON.parse(td.decode(m.payload)) as { payload?: string }
      if (!outer.payload) return
      this.push(JSON.parse(td.decode(b64decode(outer.payload))) as InnerEvent)
    } catch {
      // not a JSON event we understand: ignore
    }
  }

  push(evt: InnerEvent): void {
    this.note(String(evt.type))
    this.items.push(evt)
    this.notify()
  }

  fail(err: QuickError): void {
    this.error ??= err
    this.notify()
  }

  private notify(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  /** Next event, or null after timeoutMs with nothing received. Throws if the socket failed. */
  async next(timeoutMs: number): Promise<InnerEvent | null> {
    for (;;) {
      const item = this.items.shift()
      if (item) return item
      if (this.error) throw this.error
      const got = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = null
          resolve(false)
        }, timeoutMs)
        this.wake = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
      if (!got && this.items.length === 0 && !this.error) return null
    }
  }
}

/**
 * Runs one chat turn on a fresh Quick thread and yields every inner event.
 * Ends at message_complete (without continuation_expected), stream_ended or turn_aborted.
 * Throws QuickError for error / guardrail_blocked / stream_truncated or transport failures.
 */
export async function* quickTurn(session: QuickSession, input: TurnInput): AsyncGenerator<InnerEvent> {
  const threadId = crypto.randomUUID()
  const query = new URLSearchParams({
    surfaceType: SURFACE,
    token: session.idToken,
    workingSessionId: crypto.randomUUID(),
    channel: 'prod',
  })
  const url = `https://${session.wsHost}/streaming/quickwork-chat-bidirectional-stream?${query.toString()}`

  let resp: Response
  try {
    resp = await fetch(url, { headers: { Upgrade: 'websocket' } })
  } catch (err) {
    throw new QuickError(`Could not reach Quick: ${err instanceof Error ? err.message : String(err)}`, 'ws')
  }
  const ws = resp.webSocket
  if (!ws) {
    const kind: QuickErrorKind = resp.status === 401 || resp.status === 403 ? 'auth' : 'ws'
    throw new QuickError(`Quick WebSocket upgrade failed (HTTP ${resp.status}).`, kind)
  }
  try {
    // Ask for ArrayBuffer frames; without this, binary frames arrive as Blob in Workers.
    ;(ws as unknown as { binaryType: string }).binaryType = 'arraybuffer'
  } catch {
    // older runtimes: Blob frames are converted below
  }
  ws.accept()

  const inbox = new Inbox()
  // Blob frames must be read asynchronously; the chain keeps frames in arrival order.
  let chain: Promise<void> = Promise.resolve()
  ws.addEventListener('message', (ev: MessageEvent) => {
    const d: unknown = ev.data
    chain = chain
      .then(async () => {
        let data: string | ArrayBuffer
        if (typeof d === 'string' || d instanceof ArrayBuffer) data = d
        else if (d instanceof Blob) data = await d.arrayBuffer()
        else if (ArrayBuffer.isView(d)) data = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer
        else return
        inbox.frame(data)
      })
      .catch(() => {
        // a bad frame must not kill the turn
      })
  })
  ws.addEventListener('close', (ev: CloseEvent) => {
    // Queued behind pending frames so the last replies are not lost.
    chain = chain.then(() => inbox.fail(new QuickError(`Quick closed the socket (${ev.code}).`, 'ws')))
  })
  ws.addEventListener('error', () => inbox.fail(new QuickError('Quick socket error.', 'ws')))

  try {
    ws.send(
      wrapInput({
        type: 'session_connect',
        payload: { actor_id: session.actorArn, surfaceType: SURFACE, appVersion: APP_VERSION },
      }),
    )
    // Wait (bounded) for the session ack, as magpie does; a silent server must not hang us.
    for (;;) {
      const evt = await inbox.next(SESSION_ACK_MS)
      if (!evt || evt.type === 'session_established' || evt.type === 'connected') break
    }

    ws.send(
      wrapInput({
        type: 'user_message',
        payload: {
          thread_id: threadId,
          text: input.text,
          system_prompt: input.systemPrompt,
          agent_mode: input.mode,
          thinking_effort: input.effort,
          user_timezone: USER_TZ,
          user_locale: USER_LOCALE,
          web_search_enabled: input.webSearch,
          message_id: crypto.randomUUID(),
        },
      }),
    )

    const deadline = Date.now() + TURN_DEADLINE_MS
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) throw new QuickError('Quick did not finish the answer in time.', 'timeout')
      const evt = await inbox.next(Math.min(IDLE_MS, left))
      if (!evt) throw new QuickError(`Timed out waiting for Quick to answer (${inbox.summary()}).`, 'timeout')
      if (evt.thread_id && evt.thread_id !== threadId) continue
      yield evt
      const p = evt.payload ?? {}
      if (evt.type === 'message_complete' && p.continuation_expected !== true) return
      if (evt.type === 'stream_ended' || evt.type === 'turn_aborted') return
      if (evt.type === 'error' || evt.type === 'guardrail_blocked' || evt.type === 'stream_truncated') {
        const reason = p.message ?? evt.message ?? p.error ?? p.reason ?? evt.type
        throw new QuickError(String(reason).slice(0, 500), 'stream')
      }
    }
  } finally {
    try {
      ws.close(1000, 'done')
    } catch {
      // already closed
    }
  }
}
