// OpenAI Chat Completions endpoint: POST /v1/chat/completions
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Env } from './env'
import { randomId } from './crypto'
import { estimateUsage, openGateway, runGateway, toGatewayError, type GwEvent } from './gateway'
import { jsonResponse } from './http'
import { BadRequest, fromOpenAI, parseToolCalls, type Normalized, type ToolCall } from './translate'

type Ctx = Context<{ Bindings: Env }>

export function openAIError(message: string, type = 'api_error', code: string | null = null) {
  return { error: { message, type, param: null, code } }
}

function badRequest(message: string): Response {
  return jsonResponse(openAIError(message, 'invalid_request_error'), 400)
}

function openAIFailure(e: unknown): Response {
  const err = toGatewayError(e)
  return jsonResponse(openAIError(err.message, err.type), err.status)
}

function toolCallsOut(calls: ToolCall[]) {
  return calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }))
}

export async function chatCompletions(c: Ctx): Promise<Response> {
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
    n = fromOpenAI(body, c.req.header('x-quick-effort'))
  } catch (e) {
    if (e instanceof BadRequest) return badRequest(e.message)
    throw e
  }

  const id = randomId('chatcmpl-', 12)
  const created = Math.floor(Date.now() / 1000)
  const includeUsage = Boolean(body.stream_options?.include_usage)
  if (n.stream) return streamReply(c, n, id, created, includeUsage)
  return completeReply(c, n, id, created)
}

async function completeReply(c: Ctx, n: Normalized, id: string, created: number): Promise<Response> {
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
    return openAIFailure(e)
  }

  const parsed = n.tools.length > 0 ? parseToolCalls(text) : { content: text, toolCalls: [] as ToolCall[] }
  const calls = parsed.toolCalls
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: calls.length > 0 ? parsed.content || null : parsed.content,
  }
  if (thinking) message.reasoning_content = thinking
  if (calls.length > 0) message.tool_calls = toolCallsOut(calls)

  const usage = usageSeen ? { input, output } : estimateUsage(n, text, thinking)
  return jsonResponse(
    {
      id,
      object: 'chat.completion',
      created,
      model: n.model,
      choices: [{ index: 0, message, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop', logprobs: null }],
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
      },
    },
    200,
  )
}

async function streamReply(c: Ctx, n: Normalized, id: string, created: number, includeUsage: boolean): Promise<Response> {
  // Setup errors (no account, bad login, Quick unreachable) become a normal HTTP error here.
  let opened: Awaited<ReturnType<typeof openGateway>>
  try {
    opened = await openGateway(c.env, n)
  } catch (e) {
    return openAIFailure(e)
  }
  const { first, it } = opened
  // With tools, the reply is buffered so <tool_call> blocks can be turned into tool_calls.
  const buffered = n.tools.length > 0

  return streamSSE(c, async (stream) => {
    const send = (obj: unknown) => stream.writeSSE({ data: JSON.stringify(obj) })
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: n.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    })

    let text = ''
    let thinking = ''
    let input = 0
    let output = 0
    let usageSeen = false
    try {
      await send(chunk({ role: 'assistant', content: '' }, null))
      let r: IteratorResult<GwEvent, void> = first
      while (!r.done) {
        const e = r.value
        if (e.kind === 'text') {
          text += e.text
          if (!buffered) await send(chunk({ content: e.text }, null))
        } else if (e.kind === 'thinking') {
          thinking += e.text
          await send(chunk({ reasoning_content: e.text }, null))
        } else {
          usageSeen = true
          input += e.input
          output += e.output
        }
        r = await it.next()
      }

      let finish = 'stop'
      if (buffered) {
        const parsed = parseToolCalls(text)
        if (parsed.toolCalls.length > 0) {
          finish = 'tool_calls'
          if (parsed.content) await send(chunk({ content: parsed.content }, null))
          for (const [index, t] of parsed.toolCalls.entries()) {
            await send(
              chunk(
                { tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }] },
                null,
              ),
            )
          }
        } else if (text) {
          await send(chunk({ content: text }, null))
        }
      }
      await send(chunk({}, finish))

      if (includeUsage) {
        const usage = usageSeen ? { input, output } : estimateUsage(n, text, thinking)
        await send({
          id,
          object: 'chat.completion.chunk',
          created,
          model: n.model,
          choices: [],
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
          },
        })
      }
    } catch (e) {
      const err = toGatewayError(e)
      await stream.writeSSE({ data: JSON.stringify(openAIError(err.message, err.type)) }).catch(() => {})
    } finally {
      // Stops the Quick socket if the client went away early.
      await it.return(undefined).catch(() => {})
    }
    await stream.writeSSE({ data: '[DONE]' }).catch(() => {})
  })
}
