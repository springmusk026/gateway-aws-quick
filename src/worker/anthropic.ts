// Anthropic Messages endpoint: POST /v1/messages
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Env } from './env'
import { randomId } from './crypto'
import { estimateUsage, openGateway, runGateway, toGatewayError, type GwEvent } from './gateway'
import { jsonResponse } from './http'
import { BadRequest, fromAnthropic, parseToolCalls, type Normalized, type ToolCall } from './translate'

type Ctx = Context<{ Bindings: Env }>

export function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } }
}

function badRequest(message: string): Response {
  return jsonResponse(anthropicError('invalid_request_error', message), 400)
}

function failure(e: unknown): Response {
  const err = toGatewayError(e)
  return jsonResponse(anthropicError(err.type, err.message), err.status)
}

function toolInput(args: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(args)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toolUseId(t: ToolCall): string {
  return t.id.replace(/^call_/, 'toolu_')
}

export async function messages(c: Ctx): Promise<Response> {
  let body: Record<string, any>
  try {
    const parsed: unknown = await c.req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return badRequest('Request body must be a JSON object.')
    }
    body = parsed as Record<string, any>
  } catch {
    return badRequest('Request body must be valid JSON.')
  }

  let n: Normalized
  try {
    n = fromAnthropic(body, c.req.header('x-quick-effort'))
  } catch (e) {
    if (e instanceof BadRequest) return badRequest(e.message)
    throw e
  }

  const id = randomId('msg_', 12)
  if (n.stream) return streamMessage(c, n, id)
  return completeMessage(c, n, id)
}

async function completeMessage(c: Ctx, n: Normalized, id: string): Promise<Response> {
  let text = ''
  let thinking = ''
  let input = 0
  let output = 0
  let usageSeen = false
  try {
    for await (const e of runGateway(c.env, n)) {
      if (e.kind === 'text') text += e.text
      else if (e.kind === 'thinking') thinking += e.text
      else {
        usageSeen = true
        input += e.input
        output += e.output
      }
    }
  } catch (e) {
    return failure(e)
  }

  const parsed = n.tools.length > 0 ? parseToolCalls(text) : { content: text, toolCalls: [] as ToolCall[] }
  const content: Record<string, unknown>[] = []
  if (thinking) content.push({ type: 'thinking', thinking, signature: '' })
  if (parsed.content) content.push({ type: 'text', text: parsed.content })
  for (const t of parsed.toolCalls) {
    content.push({ type: 'tool_use', id: toolUseId(t), name: t.name, input: toolInput(t.arguments) })
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })

  const usage = usageSeen ? { input, output } : estimateUsage(n, text, thinking)
  return jsonResponse(
    {
      id,
      type: 'message',
      role: 'assistant',
      model: n.model,
      content,
      stop_reason: parsed.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: usage.output },
    },
    200,
  )
}

async function streamMessage(c: Ctx, n: Normalized, id: string): Promise<Response> {
  // Setup errors (no account, bad login, Quick unreachable) become a normal HTTP error here.
  let opened: Awaited<ReturnType<typeof openGateway>>
  try {
    opened = await openGateway(c.env, n)
  } catch (e) {
    return failure(e)
  }
  const { first, it } = opened
  // With tools, text is buffered so <tool_call> blocks can become tool_use blocks.
  const buffered = n.tools.length > 0
  const estimatedInput = estimateUsage(n, '', '').input

  return streamSSE(c, async (stream) => {
    const emit = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) })

    let index = -1
    let open: 'thinking' | 'text' | null = null
    const closeBlock = async () => {
      if (open === null) return
      await emit('content_block_stop', { type: 'content_block_stop', index })
      open = null
    }
    const openBlock = async (kind: 'thinking' | 'text') => {
      if (open === kind) return
      await closeBlock()
      index += 1
      open = kind
      const content_block = kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' }
      await emit('content_block_start', { type: 'content_block_start', index, content_block })
    }
    const delta = async (kind: 'thinking' | 'text', value: string) => {
      await openBlock(kind)
      const d = kind === 'thinking' ? { type: 'thinking_delta', thinking: value } : { type: 'text_delta', text: value }
      await emit('content_block_delta', { type: 'content_block_delta', index, delta: d })
    }

    let text = ''
    let thinking = ''
    let input = 0
    let output = 0
    let usageSeen = false
    try {
      await emit('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: n.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInput, output_tokens: 0 },
        },
      })

      let r: IteratorResult<GwEvent, void> = first
      while (!r.done) {
        const e = r.value
        if (e.kind === 'text') {
          text += e.text
          if (!buffered) await delta('text', e.text)
        } else if (e.kind === 'thinking') {
          thinking += e.text
          await delta('thinking', e.text)
        } else {
          usageSeen = true
          input += e.input
          output += e.output
        }
        r = await it.next()
      }

      let stopReason = 'end_turn'
      if (buffered) {
        const parsed = parseToolCalls(text)
        if (parsed.content) await delta('text', parsed.content)
        await closeBlock()
        for (const t of parsed.toolCalls) {
          stopReason = 'tool_use'
          index += 1
          await emit('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: toolUseId(t), name: t.name, input: {} },
          })
          await emit('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: t.arguments },
          })
          await emit('content_block_stop', { type: 'content_block_stop', index })
        }
      }
      await closeBlock()
      if (index < 0) {
        // Nothing came back; Anthropic clients expect at least one content block.
        await openBlock('text')
        await closeBlock()
      }

      const usage = usageSeen ? { input, output } : estimateUsage(n, text, thinking)
      await emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage.output },
      })
      await emit('message_stop', { type: 'message_stop' })
    } catch (e) {
      const err = toGatewayError(e)
      await emit('error', anthropicError(err.type, err.message)).catch(() => {})
    } finally {
      // Stops the Quick socket if the client went away early.
      await it.return(undefined).catch(() => {})
    }
  })
}
