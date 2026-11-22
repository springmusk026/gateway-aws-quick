// Small crypto helpers built on Web Crypto (available in Workers).

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))))
}

/** Random id with a prefix, e.g. randomId('qgk_', 32). */
export function randomId(prefix = '', bytes = 16): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return prefix + toHex(buf)
}

/** Constant-time comparison of two strings (hash both first so lengths don't leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i)
  return diff === 0
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret)))
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Encrypt a JSON-serialisable value with AES-GCM. Output: base64(iv || ciphertext). */
export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const data = enc.encode(JSON.stringify(value))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), data))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return b64encode(out)
}

export async function decryptJson<T = unknown>(secret: string, payload: string): Promise<T> {
  const raw = b64decode(payload)
  const iv = raw.slice(0, 12)
  const ct = raw.slice(12)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(secret), ct)
  return JSON.parse(dec.decode(pt)) as T
}

async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${purpose}|${secret}`)))
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function hmacSign(secret: string, purpose: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, purpose), enc.encode(message))
  return b64encode(new Uint8Array(sig))
}

export async function hmacVerify(secret: string, purpose: string, message: string, sigB64: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret, purpose), b64decode(sigB64), enc.encode(message))
  } catch {
    return false
  }
}
