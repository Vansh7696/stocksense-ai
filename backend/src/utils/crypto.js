import crypto from 'node:crypto';
import { config } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits (12 bytes) recommended for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128 bits (16 bytes) authentication tag

/**
 * Validates the encryption key.
 * The key must be a 64-character hexadecimal string representing 32 bytes (256 bits).
 * Never prints the raw key in error messages.
 *
 * @param {string} [rawKey] Key to validate, defaults to config.security.encryptionKey
 * @returns {Buffer} 32-byte key buffer
 * @throws {Error} if key is missing, not a string, or not 64 hex characters
 */
export function validateEncryptionKey(rawKey) {
  const keyToValidate = arguments.length > 0 ? rawKey : config?.security?.encryptionKey;

  if (!keyToValidate || typeof keyToValidate !== 'string') {
    throw new Error(
      '[Crypto] APP_ENCRYPTION_KEY environment variable is missing or empty. A 64-character hex key is required.'
    );
  }

  const trimmed = keyToValidate.trim();
  const hexRegex = /^[0-9a-fA-F]{64}$/;

  if (!hexRegex.test(trimmed)) {
    throw new Error(
      `[Crypto] Invalid APP_ENCRYPTION_KEY length or format: Expected 64 hexadecimal characters (32 bytes), received ${trimmed.length} characters.`
    );
  }

  return Buffer.from(trimmed, 'hex');
}

/**
 * Get active encryption key buffer.
 *
 * @param {string} [overrideKey] Optional key override for testing
 * @returns {Buffer} 32-byte Buffer
 */
export function getEncryptionKey(overrideKey) {
  return validateEncryptionKey(overrideKey || config?.security?.encryptionKey);
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Uses a fresh cryptographically secure random IV for every encryption call.
 * Never logs or prints plaintext or encryption keys.
 *
 * @param {string} plaintext String to encrypt
 * @param {string} [overrideKey] Optional 64-hex char key override
 * @returns {{ iv: string, authTag: string, ciphertext: string }}
 */
export function encrypt(plaintext, overrideKey) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('[Crypto] Plaintext must be a non-empty string');
  }

  const keyBuffer = getEncryptionKey(overrideKey);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return {
    iv: iv.toString('hex'),
    authTag,
    ciphertext,
  };
}

/**
 * Decrypt payload using AES-256-GCM and verify authentication tag.
 * Validates payload structure and ensures safe error handling on tampering or corruption.
 * Never logs or prints plaintext or encryption keys.
 *
 * @param {{ iv: string, authTag: string, ciphertext: string }} payload
 * @param {string} [overrideKey] Optional 64-hex char key override
 * @returns {string} Decrypted UTF-8 plaintext
 * @throws {Error} If authentication tag verification fails or payload is invalid
 */
export function decrypt(payload, overrideKey) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('[Crypto] Invalid decryption payload: Expected an object with iv, authTag, and ciphertext');
  }

  const { iv, authTag, ciphertext } = payload;
  const hexValidator = /^[0-9a-fA-F]+$/;

  if (typeof iv !== 'string' || iv.length !== IV_LENGTH * 2 || !hexValidator.test(iv)) {
    throw new Error(`[Crypto] Invalid IV: Expected ${IV_LENGTH * 2} hex characters`);
  }

  if (typeof authTag !== 'string' || authTag.length !== AUTH_TAG_LENGTH * 2 || !hexValidator.test(authTag)) {
    throw new Error(`[Crypto] Invalid Auth Tag: Expected ${AUTH_TAG_LENGTH * 2} hex characters`);
  }

  if (
    typeof ciphertext !== 'string' ||
    ciphertext.length === 0 ||
    ciphertext.length % 2 !== 0 ||
    !hexValidator.test(ciphertext)
  ) {
    throw new Error('[Crypto] Invalid Ciphertext: Expected valid non-empty hex string with even byte length');
  }

  const keyBuffer = getEncryptionKey(overrideKey);
  const ivBuffer = Buffer.from(iv, 'hex');
  const authTagBuffer = Buffer.from(authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, ivBuffer, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  decipher.setAuthTag(authTagBuffer);

  try {
    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');
    return plaintext;
  } catch (err) {
    throw new Error(
      `[Crypto] Decryption failed: Authentication tag verification failed or ciphertext corrupted (${err.message})`
    );
  }
}

// -------------------------------------------------------------
// Secret Redaction Logic
// -------------------------------------------------------------

// Explicit whitelist of ordinary business fields that contain "key" or "auth" or "code" but are NOT sensitive
const NON_SENSITIVE_KEYS = new Set([
  'code',
  'instrumentkey',
  'instrument_key',
  'routingkey',
  'routing_key',
  'primarykey',
  'primary_key',
  'foreignkey',
  'foreign_key',
  'sortkey',
  'sort_key',
  'compositekey',
  'composite_key',
  'author',
  'authorname',
  'author_name',
  'authors',
  'authority',
  'authenticated',
  'isauthenticated',
  'is_authenticated',
  'authorized',
  'isauthorized',
  'is_authorized',
  'authtype',
  'auth_type',
  'authenticationmethod',
  'authentication_method',
  'keyboard',
]);

// Exact matches for sensitive key names on objects
const EXACT_SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'key',
  'auth',
  'authorization',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'encryptionkey',
  'encryption_key',
  'app_encryption_key',
  'jwtsecret',
  'jwt_secret',
  'credentials',
  'credential',
  'authcode',
  'auth_code',
  'authorizationcode',
  'authorization_code',
  'oauthcode',
  'oauth_code',
]);

const SENSITIVE_PATTERNS = [
  /password$/i,
  /secret$/i,
  /token$/i,
  /_token$/i,
  /_secret$/i,
  /_password$/i,
  /apikey$/i,
  /api_key$/i,
  /private_?key$/i,
  /encryption_?key$/i,
  /^auth_/i,
  /_auth$/i,
  /^bearer/i,
];

/**
 * Checks if an object property key is sensitive.
 * Avoids false positives on business fields like instrumentKey, author, code, etc.
 *
 * @param {string} keyName
 * @returns {boolean}
 */
export function isSensitiveKey(keyName) {
  if (typeof keyName !== 'string') return false;
  const lower = keyName.toLowerCase().trim();

  // 1. Whitelist check: Never redact ordinary business fields
  if (NON_SENSITIVE_KEYS.has(lower)) {
    return false;
  }

  // 2. Exact match check
  if (EXACT_SENSITIVE_KEYS.has(lower)) {
    return true;
  }

  // 3. Pattern / compound name check
  return SENSITIVE_PATTERNS.some((p) => p.test(lower));
}

/**
 * Redacts secrets from string values (URLs, query parameters, Bearer tokens, Authorization headers).
 *
 * @param {string} str
 * @returns {string} Sanitized string
 */
export function redactString(str) {
  if (typeof str !== 'string') return str;

  let sanitized = str;

  // 1. Try JSON parsing if string looks like serialized JSON object or array
  const trimmed = sanitized.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const redactedJson = redactSecrets(parsed);
      return JSON.stringify(redactedJson);
    } catch {
      // Not valid JSON, continue with regex sanitization
    }
  }

  // 2. Redact Authorization header values: Bearer or Basic tokens across multiple formats
  sanitized = sanitized.replace(
    /(?:authorization:\s*)?(bearer|basic)\s*:?\s*[a-zA-Z0-9._~+/-]+=*/gi,
    (match, p1) => `${p1} [REDACTED]`
  );

  // 3. Redact explicit header/key assignments in logs, e.g. "authorization: 'secret'" or 'authorization: "secret"'
  sanitized = sanitized.replace(
    /(['"]?(?:authorization|accesstoken|access_token|client_secret|apikey|api_key)['"]?\s*[:=]\s*['"])[^'",\s}]+(['"])/gi,
    '$1[REDACTED]$2'
  );

  // 4. Redact URL query parameters: e.g. ?access_token=... or &client_secret=... or ?code=... or ?state=...
  sanitized = sanitized.replace(
    /([?&](?:access_token|code|state|client_secret|api_key|apiKey|token|secret|password|auth|refresh_token|refreshToken)=)[^&\s#]+/gi,
    '$1[REDACTED]'
  );

  // 5. Redact bare JSON Web Tokens (standard base64url 3-part structure starting with eyJ)
  sanitized = sanitized.replace(
    /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    '[REDACTED_JWT]'
  );

  return sanitized;
}

/**
 * Recursively redacts sensitive fields and tokens from objects, arrays, errors, and strings.
 * Uses ancestor chain tracking to handle circular references safely without misclassifying
 * shared non-circular references (DAGs).
 *
 * @param {any} data Input data
 * @param {Set} [ancestors] Set of ancestor objects in the current traversal branch
 * @returns {any} Sanitized data with secrets masked as '[REDACTED]'
 */
export function redactSecrets(data, ancestors = new Set()) {
  if (data === null || data === undefined) {
    return data;
  }

  // Strings: scrub tokens, URL query parameters, and serialized JSON
  if (typeof data === 'string') {
    return redactString(data);
  }

  // Non-object primitives (numbers, booleans, symbols)
  if (typeof data !== 'object') {
    return data;
  }

  // Error instances: sanitize message and stack trace
  if (data instanceof Error) {
    const sanitizedError = new Error(redactString(data.message));
    sanitizedError.name = data.name;
    if (data.stack) {
      sanitizedError.stack = redactString(data.stack);
    }
    return sanitizedError;
  }

  // Detect genuine circular references: object is in the current branch ancestor chain
  if (ancestors.has(data)) {
    return '[Circular]';
  }

  // Create a new ancestor set for this branch containing the current object
  const currentAncestors = new Set(ancestors);
  currentAncestors.add(data);

  if (Array.isArray(data)) {
    return data.map((item) => redactSecrets(item, currentAncestors));
  }

  const sanitized = {};

  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveKey(key)) {
      if (typeof value === 'string') {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = '[REDACTED_OBJECT]';
      } else {
        sanitized[key] = '[REDACTED]';
      }
    } else {
      sanitized[key] = redactSecrets(value, currentAncestors);
    }
  }

  return sanitized;
}
