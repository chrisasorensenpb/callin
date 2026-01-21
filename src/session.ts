import { prisma } from './db.js';
import { config } from './config.js';
import { SessionStatus } from '@prisma/client';

export async function generateUniquePairCode(): Promise<string> {
  const maxAttempts = 100;

  for (let i = 0; i < maxAttempts; i++) {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');

    // Check if code is already in use by an active session
    const existing = await prisma.session.findFirst({
      where: {
        pairCode: code,
        status: {
          in: [SessionStatus.CREATED, SessionStatus.PAIRED, SessionStatus.ACTIVE],
        },
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!existing) {
      return code;
    }
  }

  throw new Error('Unable to generate unique pair code');
}

export async function createSession(browserToken: string): Promise<{
  id: string;
  pairCode: string;
  expiresAt: Date;
}> {
  // Check for existing active session with this browser token
  const existing = await prisma.session.findFirst({
    where: {
      browserToken,
      status: {
        in: [SessionStatus.CREATED, SessionStatus.PAIRED, SessionStatus.ACTIVE],
      },
      expiresAt: {
        gt: new Date(),
      },
    },
  });

  if (existing) {
    return {
      id: existing.id,
      pairCode: existing.pairCode,
      expiresAt: existing.expiresAt,
    };
  }

  // Create new session
  const pairCode = await generateUniquePairCode();
  const expiresAt = new Date(Date.now() + config.session.expiryMinutes * 60 * 1000);

  const session = await prisma.session.create({
    data: {
      browserToken,
      pairCode,
      expiresAt,
      status: SessionStatus.CREATED,
    },
  });

  return {
    id: session.id,
    pairCode: session.pairCode,
    expiresAt: session.expiresAt,
  };
}

export async function getSession(sessionId: string) {
  return prisma.session.findUnique({
    where: { id: sessionId },
    include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
  });
}

export async function findSessionByCode(pairCode: string) {
  return prisma.session.findFirst({
    where: {
      pairCode,
      status: SessionStatus.CREATED,
      expiresAt: {
        gt: new Date(),
      },
    },
  });
}

export async function pairSession(
  sessionId: string,
  callerNumber: string,
  callerName: string,
  callSid: string
) {
  const activeUntil = new Date(Date.now() + config.session.pairedExpiryMinutes * 60 * 1000);

  const session = await prisma.session.update({
    where: { id: sessionId },
    data: {
      status: SessionStatus.PAIRED,
      callerNumber,
      callerName,
      callSid,
      activeUntil,
      expiresAt: activeUntil,
    },
  });

  // Create pairing event
  await createEvent(sessionId, 'paired', {
    callerName,
    callerNumber: maskPhoneNumber(callerNumber),
    timestamp: new Date().toISOString(),
  });

  return session;
}

export async function activateSession(sessionId: string) {
  return prisma.session.update({
    where: { id: sessionId },
    data: {
      status: SessionStatus.ACTIVE,
    },
  });
}

export async function extendSession(sessionId: string) {
  const activeUntil = new Date(Date.now() + config.session.pairedExpiryMinutes * 60 * 1000);

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      activeUntil,
      expiresAt: activeUntil,
    },
  });
}

export async function updateSessionPhone(sessionId: string, callbackPhone: string) {
  return prisma.session.update({
    where: { id: sessionId },
    data: {
      // Store callback phone in callerNumber field (overwriting the original inbound number)
      callerNumber: callbackPhone,
    },
  });
}

export async function expireSession(sessionId: string) {
  return prisma.session.update({
    where: { id: sessionId },
    data: {
      status: SessionStatus.EXPIRED,
    },
  });
}

export async function createEvent(
  sessionId: string,
  type: string,
  value: Record<string, unknown>
) {
  return prisma.event.create({
    data: {
      sessionId,
      type,
      value: value as object,
    },
  });
}

export async function cleanupExpiredSessions() {
  const result = await prisma.session.updateMany({
    where: {
      status: {
        in: [SessionStatus.CREATED, SessionStatus.PAIRED, SessionStatus.ACTIVE],
      },
      expiresAt: {
        lt: new Date(),
      },
    },
    data: {
      status: SessionStatus.EXPIRED,
    },
  });

  if (result.count > 0) {
    console.log(`Expired ${result.count} sessions`);
  }

  return result.count;
}

// Rate limiting functions
export async function checkRateLimit(callerNumber: string): Promise<{
  allowed: boolean;
  remainingAttempts?: number;
  lockedUntil?: Date;
}> {
  const record = await prisma.rateLimit.findUnique({
    where: { callerNumber },
  });

  if (!record) {
    return { allowed: true, remainingAttempts: config.rateLimit.maxAttempts };
  }

  if (record.lockedUntil && record.lockedUntil > new Date()) {
    return { allowed: false, lockedUntil: record.lockedUntil };
  }

  // Reset if lockout expired
  if (record.lockedUntil && record.lockedUntil <= new Date()) {
    await prisma.rateLimit.update({
      where: { callerNumber },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    return { allowed: true, remainingAttempts: config.rateLimit.maxAttempts };
  }

  const remaining = config.rateLimit.maxAttempts - record.failedAttempts;
  return { allowed: remaining > 0, remainingAttempts: Math.max(0, remaining) };
}

export async function recordFailedAttempt(callerNumber: string): Promise<{
  locked: boolean;
  lockedUntil?: Date;
}> {
  const record = await prisma.rateLimit.upsert({
    where: { callerNumber },
    create: {
      callerNumber,
      failedAttempts: 1,
    },
    update: {
      failedAttempts: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });

  if (record.failedAttempts >= config.rateLimit.maxAttempts) {
    const lockedUntil = new Date(Date.now() + config.rateLimit.lockoutSeconds * 1000);
    await prisma.rateLimit.update({
      where: { callerNumber },
      data: { lockedUntil },
    });
    return { locked: true, lockedUntil };
  }

  return { locked: false };
}

export async function clearRateLimit(callerNumber: string) {
  await prisma.rateLimit.deleteMany({
    where: { callerNumber },
  });
}

function maskPhoneNumber(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return `***-***-${phone.slice(-4)}`;
}
