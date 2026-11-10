import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import prisma from '../config/prisma.js';
import redisClient from '../config/redis.js';
import { config } from '../config/index.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  executeDummyPasswordComparison,
} from '../utils/password.js';

export const REDIS_REVOKED_PREFIX = 'stocksense:revoked:';

/**
 * Strips passwordHash and returns a clean, safe public user object.
 *
 * @param {Object} user
 * @returns {Object}
 */
export function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

/**
 * Computes SHA-256 hash of a raw token.
 *
 * @param {string} rawToken
 * @returns {string} Hex-encoded SHA-256 digest
 */
export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Issues a 15-minute signed JWT access token for an active user and session.
 *
 * @param {Object} user
 * @param {string} sessionId
 * @returns {string} JWT string
 */
export function generateAccessToken(user, sessionId) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: sessionId,
      type: 'access',
    },
    config.jwt.userAuthSecret,
    {
      expiresIn: config.jwt.accessTokenExpiresIn || '15m',
      algorithm: config.jwt.algorithm || 'HS256',
      issuer: config.jwt.issuer || 'stocksense-api',
      audience: config.jwt.audience || 'stocksense-client',
    }
  );
}

/**
 * Verifies access token JWT and its cryptographic claims.
 *
 * @param {string} token
 * @returns {Object} Decoded payload
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.userAuthSecret, {
    algorithms: [config.jwt.algorithm || 'HS256'],
    issuer: config.jwt.issuer || 'stocksense-api',
    audience: config.jwt.audience || 'stocksense-client',
  });
}

/**
 * User Registration Service.
 */
export async function register({ fullName, email, password, ipAddress, userAgent }) {
  const normalizedEmail = email.trim().toLowerCase();
  validatePasswordPolicy(password, { email: normalizedEmail, fullName });

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(
      'An account with this email address already exists.',
      409,
      'EMAIL_ALREADY_EXISTS'
    );
  }

  const passwordHash = await hashPassword(password);
  const rawRefreshToken = crypto.randomBytes(32).toString('hex');
  const sessionTokenHash = hashToken(rawRefreshToken);

  const now = Date.now();
  const idleExpiresAt = new Date(now + config.auth.idleSessionMs);
  const absoluteExpiresAt = new Date(now + config.auth.absoluteSessionMs);

  const result = await prisma.$transaction(async (tx) => {
    // 1. Create User
    const user = await tx.user.create({
      data: {
        fullName: fullName.trim(),
        email: normalizedEmail,
        passwordHash,
        role: 'USER',
        lastLoginAt: new Date(now),
      },
    });

    // 2. Create Default Watchlist for the user
    await tx.watchlist.create({
      data: {
        userId: user.id,
        name: 'Default Watchlist',
        isDefault: true,
      },
    });

    // 3. Create UserSession
    const session = await tx.userSession.create({
      data: {
        userId: user.id,
        userAgent: userAgent ? userAgent.slice(0, 512) : null,
        ipAddress: ipAddress ? ipAddress.slice(0, 64) : null,
        idleExpiresAt,
        absoluteExpiresAt,
      },
    });

    // 4. Create initial unconsumed UserSessionToken
    await tx.userSessionToken.create({
      data: {
        sessionId: session.id,
        tokenHash: sessionTokenHash,
        expiresAt: idleExpiresAt,
      },
    });

    return { user, session };
  });

  const accessToken = generateAccessToken(result.user, result.session.id);

  return {
    user: sanitizeUser(result.user),
    accessToken,
    refreshToken: rawRefreshToken,
    sessionId: result.session.id,
  };
}

/**
 * User Login Service.
 */
export async function login({ email, password, ipAddress, userAgent }) {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Timing equalization: evaluate dummy comparison if email does not exist
  if (!user) {
    await executeDummyPasswordComparison(password);
    throw new AppError(
      'Invalid email or password.',
      401,
      'INVALID_CREDENTIALS'
    );
  }

  const isValidPassword = await verifyPassword(user.passwordHash, password);
  if (!isValidPassword) {
    throw new AppError(
      'Invalid email or password.',
      401,
      'INVALID_CREDENTIALS'
    );
  }

  if (!user.isActive) {
    throw new AppError(
      'Your account has been deactivated. Please contact support.',
      403,
      'ACCOUNT_DEACTIVATED'
    );
  }

  const rawRefreshToken = crypto.randomBytes(32).toString('hex');
  const sessionTokenHash = hashToken(rawRefreshToken);

  const now = Date.now();
  const idleExpiresAt = new Date(now + config.auth.idleSessionMs);
  const absoluteExpiresAt = new Date(now + config.auth.absoluteSessionMs);

  const session = await prisma.$transaction(async (tx) => {
    // 1. Update lastLoginAt
    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(now) },
    });

    // 2. Create UserSession
    const newSession = await tx.userSession.create({
      data: {
        userId: user.id,
        userAgent: userAgent ? userAgent.slice(0, 512) : null,
        ipAddress: ipAddress ? ipAddress.slice(0, 64) : null,
        idleExpiresAt,
        absoluteExpiresAt,
      },
    });

    // 3. Create initial unconsumed UserSessionToken
    await tx.userSessionToken.create({
      data: {
        sessionId: newSession.id,
        tokenHash: sessionTokenHash,
        expiresAt: idleExpiresAt,
      },
    });

    return newSession;
  });

  const accessToken = generateAccessToken(user, session.id);

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken: rawRefreshToken,
    sessionId: session.id,
  };
}

/**
 * Refresh Token Rotation Service with Atomic Parameterized SQL and Replay Detection.
 *
 * Security Invariants & Isolation:
 * 1. Executes parameterized SQL UPDATE using PostgreSQL clock_timestamp() to guarantee:
 *    - tokenHash matches presented token
 *    - consumedAt IS NULL
 *    - expiresAt > clock_timestamp() (actual real-time clock, not transaction start time)
 * 2. Locks the session row with SELECT ... FOR UPDATE OF s to prevent any race condition
 *    with concurrent logout or revocation requests.
 * 3. Authoritatively verifies using PostgreSQL clock_timestamp():
 *    - Session exists and belongs to expected user
 *    - Session has not been revoked (revokedAt IS NULL)
 *    - Idle expiry has not elapsed (idleExpiresAt > clock_timestamp())
 *    - Absolute expiry has not elapsed (absoluteExpiresAt > clock_timestamp())
 *    - User account remains active (isActive = true)
 * 4. Rotates token to R_{n+1} and extends session idle expiration using current_db_time.
 * 5. Replay Protection: If token was already consumed, revokes the entire session family
 *    (TOKEN_REUSE_DETECTED) and sets negative cache in Redis.
 */
export async function refresh({ rawRefreshToken, ipAddress, userAgent }) {
  if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
    throw new AppError(
      'Refresh token is required.',
      400,
      'MISSING_REFRESH_TOKEN'
    );
  }

  const presentedTokenHash = hashToken(rawRefreshToken);

  // Execute atomic conditional update inside interactive transaction
  const result = await prisma.$transaction(async (tx) => {
    // 1. Parameterized SQL conditional update enforcing token match, unconsumed, and unexpired atomically in PostgreSQL
    // Uses clock_timestamp() so that any duration spent waiting on locks evaluates the actual current clock
    const updatedCount = await tx.$executeRaw`
      UPDATE "user_session_tokens"
      SET "consumedAt" = clock_timestamp()
      WHERE "tokenHash" = ${presentedTokenHash}
        AND "consumedAt" IS NULL
        AND "expiresAt" > clock_timestamp()
    `;

    if (updatedCount === 1) {
      // 2. Lock the session row to prevent race conditions with concurrent logout/revocation
      // Uses clock_timestamp() evaluated at row lock acquisition time to verify expiration
      const sessionRows = await tx.$queryRaw`
        SELECT
          s."id" AS "sessionId",
          s."userId",
          s."revokedAt",
          s."idleExpiresAt",
          s."absoluteExpiresAt",
          s."userAgent",
          s."ipAddress",
          u."id" AS "user_id",
          u."email",
          u."fullName",
          u."role",
          u."isActive",
          (s."idleExpiresAt" <= clock_timestamp()) AS "is_idle_expired",
          (s."absoluteExpiresAt" <= clock_timestamp()) AS "is_absolute_expired",
          clock_timestamp() AS "current_db_time"
        FROM "user_sessions" s
        JOIN "users" u ON s."userId" = u."id"
        WHERE s."id" = (
          SELECT "sessionId" FROM "user_session_tokens" WHERE "tokenHash" = ${presentedTokenHash}
        )
        FOR UPDATE OF s
      `;

      const sessionRow = sessionRows[0];
      if (!sessionRow) {
        throw new AppError('Associated session or user not found.', 401, 'INVALID_TOKEN');
      }

      // Validate session not revoked
      if (sessionRow.revokedAt !== null) {
        throw new AppError('Session has been revoked.', 401, 'SESSION_REVOKED');
      }

      // Validate session idle and absolute expirations against PostgreSQL clock_timestamp()
      if (sessionRow.is_idle_expired || sessionRow.is_absolute_expired) {
        throw new AppError('Session has expired. Please log in again.', 401, 'SESSION_EXPIRED');
      }

      // Validate user is active
      if (!sessionRow.isActive) {
        throw new AppError('Your account has been deactivated. Please contact support.', 403, 'ACCOUNT_DEACTIVATED');
      }

      // 3. Generate next generation token R_{n+1}
      const newRawRefreshToken = crypto.randomBytes(32).toString('hex');
      const newTokenHash = hashToken(newRawRefreshToken);

      const currentDbTimeMs = new Date(sessionRow.current_db_time).getTime();
      const newIdleExpiresAt = new Date(
        Math.min(currentDbTimeMs + config.auth.idleSessionMs, new Date(sessionRow.absoluteExpiresAt).getTime())
      );

      // Insert new unconsumed token
      await tx.userSessionToken.create({
        data: {
          sessionId: sessionRow.sessionId,
          tokenHash: newTokenHash,
          expiresAt: newIdleExpiresAt,
        },
      });

      // Update session idle expiration and metadata
      await tx.userSession.update({
        where: { id: sessionRow.sessionId },
        data: {
          idleExpiresAt: newIdleExpiresAt,
          userAgent: userAgent ? userAgent.slice(0, 512) : sessionRow.userAgent,
          ipAddress: ipAddress ? ipAddress.slice(0, 64) : sessionRow.ipAddress,
        },
      });

      const userObj = {
        id: sessionRow.user_id,
        email: sessionRow.email,
        fullName: sessionRow.fullName,
        role: sessionRow.role,
        isActive: sessionRow.isActive,
      };

      return {
        status: 'SUCCESS',
        user: userObj,
        sessionId: sessionRow.sessionId,
        newRefreshToken: newRawRefreshToken,
      };
    }

    // Atomic update returned 0: investigate cause deterministically using clock_timestamp()
    const tokenRows = await tx.$queryRaw`
      SELECT
        t."id",
        t."sessionId",
        t."tokenHash",
        t."consumedAt",
        t."expiresAt",
        (t."expiresAt" <= clock_timestamp()) AS "is_token_expired",
        s."revokedAt",
        (s."idleExpiresAt" <= clock_timestamp()) AS "is_idle_expired",
        (s."absoluteExpiresAt" <= clock_timestamp()) AS "is_absolute_expired"
      FROM "user_session_tokens" t
      LEFT JOIN "user_sessions" s ON t."sessionId" = s."id"
      WHERE t."tokenHash" = ${presentedTokenHash}
    `;

    const tokenRecord = tokenRows[0];
    if (!tokenRecord) {
      return { status: 'INVALID_TOKEN' };
    }

    if (tokenRecord.revokedAt !== null) {
      return { status: 'SESSION_REVOKED', sessionId: tokenRecord.sessionId };
    }

    if (tokenRecord.consumedAt !== null) {
      // Replay detected! Revoke the entire session family immediately
      await tx.$executeRaw`
        UPDATE "user_sessions"
        SET "revokedAt" = clock_timestamp(), "revocationReason" = 'TOKEN_REUSE_DETECTED'
        WHERE "id" = ${tokenRecord.sessionId}
      `;
      return { status: 'TOKEN_REUSE_DETECTED', sessionId: tokenRecord.sessionId };
    }

    // Token was unconsumed, so it failed because expiresAt <= clock_timestamp() or session expired
    return { status: 'SESSION_EXPIRED', sessionId: tokenRecord.sessionId };
  });

  // 2. Handle transaction outcomes outside transaction
  if (result.status === 'SUCCESS') {
    const accessToken = generateAccessToken(result.user, result.sessionId);
    return {
      user: sanitizeUser(result.user),
      accessToken,
      refreshToken: result.newRefreshToken,
      sessionId: result.sessionId,
    };
  }

  if (result.status === 'TOKEN_REUSE_DETECTED') {
    // Record negative revocation marker in Redis
    try {
      await redisClient.setex(`${REDIS_REVOKED_PREFIX}${result.sessionId}`, 900, '1');
    } catch {
      // Non-fatal if Redis down
    }
    throw new AppError(
      'Security alert: Token reuse detected. Your session has been revoked for security.',
      401,
      'TOKEN_REUSE_DETECTED'
    );
  }

  if (result.status === 'SESSION_REVOKED') {
    throw new AppError('Session has been revoked.', 401, 'SESSION_REVOKED');
  }

  if (result.status === 'SESSION_EXPIRED') {
    throw new AppError('Session has expired. Please log in again.', 401, 'SESSION_EXPIRED');
  }

  throw new AppError('Invalid refresh token.', 401, 'INVALID_TOKEN');
}

/**
 * User Logout Service. Marks session revoked in PostgreSQL and sets Redis revocation marker.
 *
 * @param {string} sessionId
 */
export async function logout(sessionId) {
  if (!sessionId) return { success: true };

  // 1. PostgreSQL is the authoritative authority: atomic update with row locking
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "user_sessions"
        SET "revokedAt" = clock_timestamp(), "revocationReason" = 'LOGOUT'
        WHERE "id" = ${sessionId} AND "revokedAt" IS NULL
      `;
    });
  } catch (err) {
    throw new AppError(
      'Database error during logout.',
      503,
      'SERVICE_UNAVAILABLE'
    );
  }

  // 2. Set negative revocation marker in Redis (TTL 15m = access token lifespan)
  try {
    await redisClient.setex(`${REDIS_REVOKED_PREFIX}${sessionId}`, 900, '1');
  } catch {
    // Zero security compromise if Redis fails: PostgreSQL remains authoritative
  }

  return { success: true };
}

/**
 * Authoritatively validates a session against PostgreSQL, with Redis negative revocation check.
 *
 * @param {string} sessionId
 * @returns {Promise<Object>} Safe User object
 */
export async function validateSessionAuthoritative(sessionId) {
  if (!sessionId) {
    throw new AppError('Missing session identifier in token.', 401, 'INVALID_TOKEN');
  }

  // 1. Fast short-circuit: Check Redis negative revocation marker
  try {
    const isRevoked = await redisClient.get(`${REDIS_REVOKED_PREFIX}${sessionId}`);
    if (isRevoked) {
      throw new AppError('Session has been revoked.', 401, 'SESSION_REVOKED');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // If Redis is offline, continue straight to PostgreSQL authority!
  }

  // 2. Authoritative PostgreSQL verification using clock_timestamp()
  let sessionRows;
  try {
    sessionRows = await prisma.$queryRaw`
      SELECT
        s."id",
        s."userId",
        s."revokedAt",
        (s."idleExpiresAt" <= clock_timestamp()) AS "is_idle_expired",
        (s."absoluteExpiresAt" <= clock_timestamp()) AS "is_absolute_expired",
        u."id" AS "user_id",
        u."email",
        u."fullName",
        u."role",
        u."isActive",
        u."lastLoginAt",
        u."createdAt",
        u."updatedAt"
      FROM "user_sessions" s
      JOIN "users" u ON s."userId" = u."id"
      WHERE s."id" = ${sessionId}
    `;
  } catch (err) {
    // Fail Closed: If PostgreSQL is offline, reject with 503
    throw new AppError(
      'Authentication service unavailable: Database offline.',
      503,
      'SERVICE_UNAVAILABLE'
    );
  }

  const session = sessionRows[0];
  if (!session) {
    throw new AppError('Session not found.', 401, 'SESSION_REVOKED');
  }

  if (session.revokedAt !== null) {
    // Cache negative marker in Redis
    try {
      await redisClient.setex(`${REDIS_REVOKED_PREFIX}${sessionId}`, 900, '1');
    } catch {}
    throw new AppError('Session has been revoked.', 401, 'SESSION_REVOKED');
  }

  if (session.is_idle_expired || session.is_absolute_expired) {
    throw new AppError('Session has expired. Please log in again.', 401, 'SESSION_EXPIRED');
  }

  if (!session.isActive) {
    throw new AppError('Account has been deactivated.', 403, 'ACCOUNT_DEACTIVATED');
  }

  return {
    id: session.user_id,
    email: session.email,
    fullName: session.fullName,
    role: session.role,
    isActive: session.isActive,
    lastLoginAt: session.lastLoginAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
