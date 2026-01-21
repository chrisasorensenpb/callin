import express from 'express';
import { createServer } from 'http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { config, validateConfig, validateTwilioCredentials, validateRetellCredentials } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { initializeWebSocket } from './websocket.js';
import { cleanupExpiredSessions } from './session.js';
import apiRoutes from './api.js';
import twilioRoutes from './twilio.js';
import retellRoutes from './retell.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // Validate configuration
  validateConfig();

  // Connect to database
  await connectDatabase();

  // Create Express app
  const app = express();
  const httpServer = createServer(app);

  // Initialize WebSocket
  initializeWebSocket(httpServer);

  // Middleware
  app.use(cors({
    origin: config.nodeEnv === 'production' ? false : true,
    credentials: true,
  }));

  // Parse URL-encoded bodies for Twilio webhooks
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());

  // Request logging
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });

  // API routes
  app.use('/api', apiRoutes);

  // Twilio webhooks (legacy, kept for rollback)
  app.use('/twilio', twilioRoutes);

  // Retell AI webhooks
  app.use('/retell', retellRoutes);

  // Serve static files
  const publicPath = config.nodeEnv === 'production'
    ? path.join(__dirname, 'public')
    : path.join(__dirname, '..', 'dist', 'public');
  app.use(express.static(publicPath));

  // SPA fallback
  app.get('*', (req, res) => {
    // Don't serve index.html for API, Twilio, or Retell routes
    if (req.path.startsWith('/api') || req.path.startsWith('/twilio') || req.path.startsWith('/retell')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Session cleanup job (every minute)
  const cleanupInterval = setInterval(async () => {
    try {
      await cleanupExpiredSessions();
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }, 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    clearInterval(cleanupInterval);
    await disconnectDatabase();
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  httpServer.listen(config.port, async () => {
    console.log(`Server running on port ${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Twilio phone: ${config.twilio.phoneNumber || 'Not configured'}`);
    console.log(`Retell agent: ${config.retell.agentId || 'Not configured'}`);

    // Validate credentials on startup
    await validateTwilioCredentials();
    await validateRetellCredentials();
  });
}

main().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
