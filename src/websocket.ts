import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

let io: Server | null = null;

const sessionSockets = new Map<string, Set<string>>();

export function initializeWebSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.NODE_ENV === 'production' ? false : '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on('connection', (socket: Socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('subscribe', (sessionId: string) => {
      if (!sessionId || typeof sessionId !== 'string') {
        socket.emit('error', { message: 'Invalid session ID' });
        return;
      }

      // Add socket to session room
      socket.join(`session:${sessionId}`);

      // Track socket -> session mapping
      if (!sessionSockets.has(sessionId)) {
        sessionSockets.set(sessionId, new Set());
      }
      sessionSockets.get(sessionId)!.add(socket.id);

      console.log(`Socket ${socket.id} subscribed to session ${sessionId}`);
      socket.emit('subscribed', { sessionId });
    });

    socket.on('unsubscribe', (sessionId: string) => {
      socket.leave(`session:${sessionId}`);

      const sockets = sessionSockets.get(sessionId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          sessionSockets.delete(sessionId);
        }
      }

      console.log(`Socket ${socket.id} unsubscribed from session ${sessionId}`);
    });

    socket.on('disconnect', () => {
      // Clean up socket from all sessions
      for (const [sessionId, sockets] of sessionSockets.entries()) {
        if (sockets.has(socket.id)) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            sessionSockets.delete(sessionId);
          }
        }
      }
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function emitToSession(sessionId: string, event: string, data: unknown): boolean {
  if (!io) {
    console.error('WebSocket server not initialized');
    return false;
  }

  io.to(`session:${sessionId}`).emit(event, data);
  console.log(`Emitted ${event} to session ${sessionId}:`, data);
  return true;
}

export function getConnectedClients(sessionId: string): number {
  return sessionSockets.get(sessionId)?.size || 0;
}

export function getIO(): Server | null {
  return io;
}
