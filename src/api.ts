import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createSession, getSession, cleanupExpiredSessions } from './session.js';
import { config } from './config.js';

const router = Router();

// Create or retrieve session
router.post('/session', async (req: Request, res: Response) => {
  try {
    // Get or create browser token from cookie
    let browserToken = req.cookies?.browserToken;

    if (!browserToken) {
      browserToken = uuidv4();
      res.cookie('browserToken', browserToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      });
    }

    const session = await createSession(browserToken);

    res.json({
      sessionId: session.id,
      pairCode: session.pairCode,
      expiresAt: session.expiresAt.toISOString(),
      phoneNumber: config.twilio.phoneNumber,
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Get session status
router.get('/session/:id', async (req: Request, res: Response) => {
  try {
    const session = await getSession(req.params.id);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      id: session.id,
      status: session.status,
      pairCode: session.pairCode,
      expiresAt: session.expiresAt.toISOString(),
      activeUntil: session.activeUntil?.toISOString(),
      callerName: session.callerName,
      events: session.events.map(e => ({
        type: e.type,
        value: e.value,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Health check
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    phoneNumber: config.twilio.phoneNumber,
  });
});

// Manual cleanup endpoint (for testing)
router.post('/cleanup', async (_req: Request, res: Response) => {
  try {
    const count = await cleanupExpiredSessions();
    res.json({ expiredCount: count });
  } catch (error) {
    console.error('Error cleaning up sessions:', error);
    res.status(500).json({ error: 'Failed to cleanup sessions' });
  }
});

export default router;
