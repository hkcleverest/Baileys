import express, { Request, Response, NextFunction } from 'express';
import { SessionManager } from './baileys';
import { logger } from './logger';

const app = express();
const sessionManager = new SessionManager();

app.use(express.json());

// Auth middleware (skip /health)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') {
    return next();
  }

  const auth = req.headers.authorization;
  const token = auth?.replace('Bearer ', '');

  if (!token || token !== process.env.API_KEY) {
    logger.warn({ path: req.path }, 'Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
});

// Health check (no auth required)
app.get('/health', (req: Request, res: Response) => {
  res.json({ ok: true });
});

// Start a session
app.post('/sessions/:sessionId/start', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const status = await sessionManager.startSession(sessionId);
    res.json({ status });
  } catch (error) {
    logger.error(error, 'Failed to start session');
    res
      .status(500)
      .json({ error: 'Failed to start session' });
  }
});

// Get QR code
app.get('/sessions/:sessionId/qr', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const qr = await sessionManager.getQR(sessionId);
    if (qr) {
      res.json({ qr });
    } else {
      res.json({ status: 'connected' });
    }
  } catch (error) {
    logger.error(error, 'Failed to get QR');
    res.status(500).json({ error: 'Failed to get QR' });
  }
});

// Get session status
app.get(
  '/sessions/:sessionId/status',
  async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
      const { status, me } = await sessionManager.getStatus(sessionId);
      res.json({ status, me });
    } catch (error) {
      logger.error(error, 'Failed to get status');
      res.status(500).json({ error: 'Failed to get status' });
    }
  }
);

// Logout
app.post('/sessions/:sessionId/logout', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    await sessionManager.logout(sessionId);
    res.json({ ok: true });
  } catch (error) {
    logger.error(error, 'Failed to logout');
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Send text message
app.post(
  '/sessions/:sessionId/send',
  async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { to, text } = req.body;

    if (!sessionId || !to || !text) {
      return res
        .status(400)
        .json({ error: 'sessionId, to, and text are required' });
    }

    try {
      const messageId = await sessionManager.sendMessage(sessionId, to, text);
      res.json({ ok: true, messageId });
    } catch (error) {
      logger.error(error, 'Failed to send message');
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// Send media
app.post(
  '/sessions/:sessionId/send-media',
  async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { to, mediaUrl, caption, type } = req.body;

    if (!sessionId || !to || !mediaUrl) {
      return res
        .status(400)
        .json({ error: 'sessionId, to, and mediaUrl are required' });
    }

    try {
      const messageId = await sessionManager.sendMedia(
        sessionId,
        to,
        mediaUrl,
        caption,
        type
      );
      res.json({ ok: true, messageId });
    } catch (error) {
      logger.error(error, 'Failed to send media');
      res.status(500).json({ error: 'Failed to send media' });
    }
  }
);

const PORT = parseInt(process.env.PORT || '8234', 10);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server listening');
});

