import type { Env } from './env'
import { AccountError, freshSession, listAccounts, pickAccounts, recordFailure, recordUse } from './accounts'
import { QuickError, quickTurn, type InnerEvent } from './quick'
import { estimateTokens, renderUserMessage, type Normalized } from './translate'

export type GwEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'usage'; input: number; output: number; model: string }

export class GatewayError extends Error {
  status: number
  type: string
  constructor(message: string, status = 502, type = 'api_error') {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.type = type
  }
}

export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err
  if (err instanceof QuickError) {
    if (err.kind === 'auth') return new GatewayError('Quick rejected this login. Import the account again.', 401, 'authentication_error')
    if (err.kind === 'timeout') return new GatewayError(err.message, 504, 'api_error')
    return new GatewayError(err.message, 502, 'api_error')
  }
  if (err instanceof AccountError) return new GatewayError(err.message, 503, 'api_error')
  // Raw error text (for example network details) stays out of the response; only the error name is logged.
  console.error('gateway error', err instanceof Error ? err.name : 'unknown')
  return new GatewayError('Could not get a reply from Quick. Try again in a moment.', 502, 'api_error')
}

function numberOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function toGwEvent(evt: InnerEvent, model: string): GwEvent | null {
  const p = evt.payload ?? {}
  switch (evt.type) {
    case 'text_delta': {
      const text = String(p.delta ?? p.text ?? '')
      return text ? { kind: 'text', text } : null
    }
    case 'thinking_delta': {
      const text = String(p.delta ?? p.text ?? '')
      return text ? { kind: 'thinking', text } : null
    }
    case 'turn_usage':
      return {
        kind: 'usage',
        input: numberOf(p.input_tokens),
        output: numberOf(p.output_tokens),
        model: String(p.served_model_id ?? p.resolved_model_id ?? model),
      }
    default:
      return null
  }
}

/**
 * Runs one request through the enabled Quick accounts, least recently used first.
 * If an account fails before it has produced any output, the next account is tried.
 * Once output has started, a failure is final (the client already has part of the answer).
 */
export interface RunOptions {
  /** Use only this account, even if it is disabled (admin chat test). */
  accountId?: string
}

export async function* runGateway(env: Env, n: Normalized, opts: RunOptions = {}): AsyncGenerator<GwEvent> {
  const accounts = opts.accountId
    ? (await listAccounts(env)).filter((a) => a.id === opts.accountId)
    : await pickAccounts(env)
  if (accounts.length === 0) {
    throw opts.accountId
      ? new GatewayError('Account not found.', 404, 'invalid_request_error')
      : new GatewayError('No enabled Quick account with a working login. Add one in the admin page.', 503, 'api_error')
  }
  const prompt = renderUserMessage(n)
  const promptTokens = estimateTokens(n.system) + estimateTokens(prompt)
  let lastErr: unknown = null
  for (const acct of accounts) {
    let emitted = false
    let input = 0
    let output = 0
    let usageSeen = false
    let chars = 0
    try {
      const session = await freshSession(env, acct.id)
      for await (const evt of quickTurn(session, {
        text: prompt,
        systemPrompt: n.system,
        mode: n.mode,
        effort: n.effort,
        webSearch: false,
      })) {
        const out = toGwEvent(evt, n.model)
        if (out) {
          if (out.kind === 'usage') {
            usageSeen = true
            input += out.input
            output += out.output
          } else {
            chars += out.text.length
          }
          emitted = true
          yield out
        }
      }
      await recordUse(
        env,
        acct.id,
        usageSeen ? { input, output } : { input: promptTokens, output: Math.ceil(chars / 4) },
      )
      return
    } catch (err) {
      await recordFailure(env, acct.id, err)
      if (emitted) throw toGatewayError(err)
      lastErr = err
    }
  }
  throw toGatewayError(lastErr)
}

/**
 * Starts the gateway and waits for the first event. Setup errors (no accounts, bad login,
 * Quick unreachable) therefore surface before any response headers are sent, so the
 * handler can return a proper HTTP error.
 */
export async function openGateway(env: Env, n: Normalized) {
  const it = runGateway(env, n)
  const first = await it.next()
  return { first, it }
}

/** Token counts for replies where Quick did not report turn_usage (rough, about 4 characters per token). */
export function estimateUsage(n: Normalized, text: string, thinking: string): { input: number; output: number } {
  return {
    input: estimateTokens(n.system) + estimateTokens(renderUserMessage(n)),
    output: estimateTokens(text + thinking),
  }
}
