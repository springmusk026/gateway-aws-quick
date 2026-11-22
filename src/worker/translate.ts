// Converts OpenAI Chat Completions and Anthropic Messages requests into one Quick turn,
// and parses tool calls back out of the reply.
//
// Quick has no native tool channel, so tools are described in the message text and the
// model is asked to answer with <tool_call>{"name":…,"arguments":{…}}</tool_call> blocks
// (the same convention magpie uses).
import { randomId } from './crypto'
import type { AgentMode, Effort } from './quick'

export class BadRequest extends Error {}

export interface ToolCall {
  id: string
  name: string
  arguments: string // JSON text
}

export interface Msg {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: unknown
}

export interface Normalized {
  model: string
  system: string
  messages: Msg[]
  tools: ToolDef[]
  toolChoice: 'auto' | 'none' | 'required' | string // string = a specific tool name
  mode: AgentMode
  effort: Effort
  stream: boolean
}

type Raw = Record<string, any>

const MAX_PROMPT_BYTES = 56 * 1024 // Quick caps a user_message at 64KB; keep headroom
const EFFORTS: Effort[] = ['off', 'low', 'medium', 'high', 'max']
const enc = new TextEncoder()

export function resolveMode(model: string): AgentMode {
  const m = model.toLowerCase()
  if (m.includes('advanced')) return 'advanced'
  if (m.includes('smart') || m.includes('opus')) return 'smart'
  if (m.includes('fast') || m.includes('haiku') || m.includes('mini')) return 'fast'
  return 'balanced'
}

function pickEffort(...candidates: unknown[]): Effort | null {
  for (const c of candidates) {
    if (typeof c === 'string') {
      const v = c.trim().toLowerCase()
      if (v === 'minimal') return 'low'
      if ((EFFORTS as string[]).includes(v)) return v as Effort
    }
  }
  return null
}

function textFromContent(content: unknown, label: string): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  const parts: string[] = []
  for (const block of content as Raw[]) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image_url' || block.type === 'image') parts.push(`[${label} image omitted: images are not supported by this gateway]`)
  }
  return parts.join('\n')
}

function toolsFromOpenAI(raw: unknown): ToolDef[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t: Raw) => t?.type === 'function' && t.function?.name)
    .map((t: Raw) => ({
      name: String(t.function.name),
      description: String(t.function.description ?? ''),
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    }))
}

function toolChoiceFromOpenAI(raw: unknown): Normalized['toolChoice'] {
  if (raw === 'none' || raw === 'required' || raw === 'auto' || raw == null) return (raw as string) ?? 'auto'
  if (raw && typeof raw === 'object' && (raw as Raw).function?.name) return String((raw as Raw).function.name)
  return 'auto'
}

export function fromOpenAI(body: Raw, effortHeader: string | undefined): Normalized {
  if (!body || typeof body !== 'object') throw new BadRequest('Request body must be a JSON object.')
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new BadRequest('messages must be a non-empty array.')
  const systemParts: string[] = []
  const messages: Msg[] = []
  for (const m of body.messages as Raw[]) {
    switch (m?.role) {
      case 'system':
      case 'developer':
        systemParts.push(textFromContent(m.content, 'system'))
        break
      case 'user':
        messages.push({ role: 'user', text: textFromContent(m.content, 'user') })
        break
      case 'assistant': {
        const toolCalls: ToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc: Raw) => ({
          id: String(tc.id ?? randomId('call_', 8)),
          name: String(tc.function?.name ?? ''),
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        }))
        messages.push({ role: 'assistant', text: textFromContent(m.content, 'assistant'), toolCalls })
        break
      }
      case 'tool':
        messages.push({ role: 'tool', text: textFromContent(m.content, 'tool'), toolCallId: String(m.tool_call_id ?? '') })
        break
      default:
        throw new BadRequest(`Unsupported message role: ${String(m?.role)}`)
    }
  }
  const model = typeof body.model === 'string' && body.model ? body.model : 'quick-balanced'
  const choice = toolChoiceFromOpenAI(body.tool_choice)
  return {
    model,
    system: systemParts.filter(Boolean).join('\n\n'),
    messages,
    tools: toolsFromOpenAI(body.tools),
    toolChoice: choice,
    mode: resolveMode(model),
    effort: pickEffort(effortHeader, body.reasoning_effort) ?? 'off',
    stream: body.stream === true,
  }
}

function anthropicEffort(thinking: Raw | undefined): Effort | null {
  if (!thinking || typeof thinking !== 'object') return null
  if (thinking.type !== 'enabled') return 'off'
  const budget = Number(thinking.budget_tokens) || 0
  if (budget <= 2000) return 'low'
  if (budget <= 8000) return 'medium'
  if (budget <= 16000) return 'high'
  return 'max'
}

export function fromAnthropic(body: Raw, effortHeader: string | undefined): Normalized {
  if (!body || typeof body !== 'object') throw new BadRequest('Request body must be a JSON object.')
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new BadRequest('messages must be a non-empty array.')
  const system = textFromContent(body.system, 'system')
  const messages: Msg[] = []
  for (const m of body.messages as Raw[]) {
    if (m?.role !== 'user' && m?.role !== 'assistant') throw new BadRequest(`Unsupported message role: ${String(m?.role)}`)
    if (typeof m.content === 'string' || m.content == null) {
      messages.push({ role: m.role, text: m.content ?? '' })
      continue
    }
    if (!Array.isArray(m.content)) throw new BadRequest('message content must be a string or an array of blocks.')
    if (m.role === 'assistant') {
      const toolCalls: ToolCall[] = []
      for (const b of m.content as Raw[]) {
        if (b?.type === 'tool_use') {
          toolCalls.push({ id: String(b.id ?? randomId('toolu_', 8)), name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) })
        }
      }
      messages.push({ role: 'assistant', text: textFromContent(m.content, 'assistant'), toolCalls })
      continue
    }
    // user: tool_result blocks become tool messages; the rest is user text
    const rest: Raw[] = []
    for (const b of m.content as Raw[]) {
      if (b?.type === 'tool_result') {
        messages.push({ role: 'tool', text: textFromContent(b.content, 'tool'), toolCallId: String(b.tool_use_id ?? '') })
      } else {
        rest.push(b)
      }
    }
    const text = textFromContent(rest, 'user')
    if (text || messages.length === 0 || messages[messages.length - 1].role !== 'tool') messages.push({ role: 'user', text })
  }
  const tools: ToolDef[] = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t: Raw) => t?.name)
    .map((t: Raw) => ({ name: String(t.name), description: String(t.description ?? ''), parameters: t.input_schema ?? { type: 'object', properties: {} } }))
  const tc: Raw = body.tool_choice ?? {}
  const toolChoice: Normalized['toolChoice'] =
    tc.type === 'none' ? 'none' : tc.type === 'any' ? 'required' : tc.type === 'tool' && tc.name ? String(tc.name) : 'auto'
  const model = typeof body.model === 'string' && body.model ? body.model : 'quick-balanced'
  return {
    model,
    system,
    messages,
    tools,
    toolChoice,
    mode: resolveMode(model),
    effort: pickEffort(effortHeader) ?? anthropicEffort(body.thinking) ?? 'off',
    stream: body.stream === true,
  }
}

function toolPreamble(n: Normalized): string {
  const lines = [
    'You can call tools. To call one, reply with only <tool_call> blocks, one per call, in exactly this form:',
    '<tool_call>{"name": "TOOL_NAME", "arguments": {…JSON matching the schema…}}</tool_call>',
    'After tool results come back, keep working on the task. When no tool is needed, answer normally.',
  ]
  if (n.toolChoice === 'required') lines.push('You must call at least one tool in this reply.')
  else if (n.toolChoice !== 'auto') lines.push(`You must call the tool ${n.toolChoice} in this reply.`)
  lines.push('Tools:')
  for (const t of n.tools) {
    lines.push(`- ${t.name}: ${t.description}`.trimEnd())
    lines.push(`  parameters: ${JSON.stringify(t.parameters)}`)
  }
  return lines.join('\n')
}

function renderHistoryLine(m: Msg): string {
  if (m.role === 'user') return `User: ${m.text}`
  if (m.role === 'tool') return `Tool result (call ${m.toolCallId ?? '?'}): ${m.text}`
  const calls = (m.toolCalls ?? []).map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: safeJson(c.arguments) })}</tool_call>`)
  return [`Assistant: ${m.text}`.trimEnd(), ...calls].filter(Boolean).join('\n')
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** One Quick user_message text: tools preamble, earlier conversation, then the current request. */
export function renderUserMessage(n: Normalized): string {
  const preamble = n.tools.length && n.toolChoice !== 'none' ? toolPreamble(n) : ''

  // The current request is the trailing run of user/tool messages; everything before it is history.
  let split = n.messages.length
  while (split > 0 && n.messages[split - 1].role !== 'assistant') split--
  if (split === n.messages.length && split > 0) split = n.messages.length - 1
  let history = n.messages.slice(0, split).map(renderHistoryLine)
  const current = n.messages.slice(split)
  let currentText = current
    .map((m) => (m.role === 'tool' ? `Tool result (call ${m.toolCallId ?? '?'}):\n${m.text}` : m.text))
    .join('\n\n')
  if (!currentText.trim()) currentText = 'Continue.'

  const build = (hist: string[], cur: string) => {
    const sections: string[] = []
    if (preamble) sections.push(preamble)
    if (hist.length) sections.push(`[Earlier conversation]\n${hist.join('\n\n')}\n[End of earlier conversation]`)
    sections.push(hist.length ? `[Current request]\n${cur}` : cur)
    return sections.join('\n\n')
  }
  let text = build(history, currentText)
  while (enc.encode(text).length > MAX_PROMPT_BYTES && history.length > 0) {
    history = history.slice(1)
    text = build(history, currentText)
  }
  if (enc.encode(text).length > MAX_PROMPT_BYTES) {
    // Keep the end of the current request, which is what the model must act on.
    const room = MAX_PROMPT_BYTES - enc.encode(build([], '')).length - 200
    const tail = new TextDecoder().decode(enc.encode(currentText).slice(-Math.max(room, 1000)))
    text = build([], `[Earlier part of this request was truncated to fit the gateway limit.]\n${tail}`)
  }
  return text
}

/** Splits a reply into prose and <tool_call> blocks. Malformed blocks stay in the prose. */
export function parseToolCalls(text: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = []
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let content = ''
  let last = 0
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0
    content += text.slice(last, start)
    last = start + match[0].length
    try {
      const obj = JSON.parse(match[1]) as Raw
      if (typeof obj.name !== 'string' || !obj.name) throw new Error('no name')
      const args = obj.arguments ?? {}
      toolCalls.push({
        id: randomId('call_', 12),
        name: obj.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      })
    } catch {
      content += match[0]
    }
  }
  content += text.slice(last)
  return { content: content.trim(), toolCalls }
}

export function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4))
}
