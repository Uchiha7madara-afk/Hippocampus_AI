import crypto from 'crypto';

const GCM_ALGO = 'aes-256-gcm';
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CIPHERTEXT_PREFIX = 'v1';

export const OAUTH_BINDING_COOKIE_NAME = 'hippocampus_gh_oauth_bind';

// Ephemeral in-memory keys used ONLY in development/test when env secrets are unset.
// In production, missing keys fail closed — these ephemeral keys are NEVER used in production.
let ephemeralEncryptionKey: Buffer | null = null;
let ephemeralCookieSigningKey: Buffer | null = null;

function isPlaceholderSecret(val?: string): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('MY_') ||
    trimmed.startsWith('YOUR_') ||
    trimmed === 'placeholder'
  );
}

function parseAes256Key(raw: string): Buffer {
  const trimmed = raw.trim();
  // Accept 64-char hex (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  // Accept base64 encoding of exactly 32 bytes
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === 32 && b64.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) {
    return b64;
  }
  // Accept high-entropy passphrase (>= 32 chars) deterministically derived via SHA-256
  if (trimmed.length >= 32) {
    return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
  }
  throw new Error(
    'CONNECTOR_TOKEN_ENCRYPTION_KEY must be a 32-byte hex/base64 key or at least 32 characters.'
  );
}

export function isTokenEncryptionConfigured(): boolean {
  const raw = process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
  if (isPlaceholderSecret(raw)) return false;
  try {
    parseAes256Key(raw!);
    return true;
  } catch {
    return false;
  }
}

function resolveEncryptionKey(): Buffer {
  const raw = process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
  if (!isPlaceholderSecret(raw)) {
    return parseAes256Key(raw!);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CONNECTOR_TOKEN_ENCRYPTION_KEY is required in production for encrypted OAuth token storage.'
    );
  }
  if (!ephemeralEncryptionKey) {
    ephemeralEncryptionKey = crypto.randomBytes(32);
  }
  return ephemeralEncryptionKey;
}

function resolveCookieSigningKey(): Buffer {
  const explicit = process.env.OAUTH_STATE_COOKIE_SECRET;
  if (!isPlaceholderSecret(explicit) && explicit!.trim().length >= 32) {
    return crypto.createHash('sha256').update(explicit!.trim(), 'utf8').digest();
  }
  const encRaw = process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY;
  if (!isPlaceholderSecret(encRaw)) {
    // Domain-separated HKDF-style subkey derived from encryption key
    return crypto
      .createHmac('sha256', parseAes256Key(encRaw!))
      .update('hippocampus:oauth_binding_cookie:v1')
      .digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'OAUTH_STATE_COOKIE_SECRET or CONNECTOR_TOKEN_ENCRYPTION_KEY is required in production.'
    );
  }
  if (!ephemeralCookieSigningKey) {
    ephemeralCookieSigningKey = crypto.randomBytes(32);
  }
  return ephemeralCookieSigningKey;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateRandomTokenHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * RFC 7636 PKCE S256 verifier + challenge pair.
 */
export function generatePkcePair(): {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier, 'ascii')
    .digest('base64url');
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

/**
 * AES-256-GCM authenticated encryption at rest with optional AAD (e.g. userUid:provider).
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const key = resolveEncryptionKey();
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv(GCM_ALGO, key, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    CIPHERTEXT_PREFIX,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, aad?: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_PREFIX) {
    throw new Error('Malformed encrypted token payload.');
  }
  const key = resolveEncryptionKey();
  const iv = Buffer.from(parts[1], 'base64url');
  const authTag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');

  if (iv.length !== GCM_IV_BYTES || authTag.length !== GCM_TAG_BYTES) {
    throw new Error('Invalid encrypted token parameters.');
  }

  const decipher = crypto.createDecipheriv(GCM_ALGO, key, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * Signed HttpOnly OAuth browser-binding cookie: `<nonce>.<hmac_sha256_b64url>`
 */
export function signOAuthBindingCookie(nonce: string): string {
  const key = resolveCookieSigningKey();
  const sig = crypto
    .createHmac('sha256', key)
    .update(`gh-oauth-bind:${nonce}`, 'utf8')
    .digest('base64url');
  return `${nonce}.${sig}`;
}

export function verifyOAuthBindingCookie(
  cookieValue: string | undefined | null
): { valid: true; nonce: string; bindingHash: string } | { valid: false } {
  if (!cookieValue || typeof cookieValue !== 'string') {
    return { valid: false };
  }
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return { valid: false };
  const [nonce, providedSig] = parts;
  if (!/^[a-f0-9]{32,128}$/i.test(nonce) || !providedSig) {
    return { valid: false };
  }

  try {
    const key = resolveCookieSigningKey();
    const expectedSig = crypto
      .createHmac('sha256', key)
      .update(`gh-oauth-bind:${nonce}`, 'utf8')
      .digest('base64url');

    const providedBuf = Buffer.from(providedSig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (providedBuf.length !== expectedBuf.length) {
      return { valid: false };
    }
    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false };
    }
    return {
      valid: true,
      nonce,
      bindingHash: sha256Hex(nonce),
    };
  } catch {
    return { valid: false };
  }
}

export function timingSafeHashEquals(hashA: string, hashB: string): boolean {
  const bufA = Buffer.from(hashA, 'utf8');
  const bufB = Buffer.from(hashB, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function parseCookies(
  cookieHeader: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const segment of cookieHeader.split(';')) {
    const idx = segment.indexOf('=');
    if (idx <= 0) continue;
    const name = segment.slice(0, idx).trim();
    const rawVal = segment.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(rawVal);
    } catch {
      out[name] = rawVal;
    }
  }
  return out;
}

export function buildOAuthBindingCookieHeader(
  signedValue: string,
  options: { isSecureContext: boolean; maxAgeSeconds?: number }
): string {
  const maxAge = options.maxAgeSeconds ?? 600;
  const parts = [
    `${OAUTH_BINDING_COOKIE_NAME}=${encodeURIComponent(signedValue)}`,
    'Path=/auth/github/callback',
    `Max-Age=${maxAge}`,
    'HttpOnly',
  ];
  if (options.isSecureContext) {
    // Required for HTTPS + cross-origin iframe preview context (AI Studio)
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

export function buildClearOAuthBindingCookieHeader(options: {
  isSecureContext: boolean;
}): string {
  const parts = [
    `${OAUTH_BINDING_COOKIE_NAME}=`,
    'Path=/auth/github/callback',
    'Max-Age=0',
    'HttpOnly',
  ];
  if (options.isSecureContext) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

/**
 * Safely serializes JSON for embedding inside an HTML <script> block.
 * Neutralizes </script>, HTML comment sequences, &, and JS line terminators (U+2028/U+2029).
 */
export function serializeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
