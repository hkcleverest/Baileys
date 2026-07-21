import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  AnyMessageContent,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import axios from 'axios';
import { logger } from './logger';
import * as fs from 'fs/promises';
import * as path from 'path';

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/data/sessions';

interface SessionState {
  socket: ReturnType<typeof makeWASocket> | null;
  qr: string | null;
  status: 'connecting' | 'connected' | 'disconnected';
  me: any;
}

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();

  async initDir() {
    try {
      await fs.mkdir(SESSIONS_DIR, { recursive: true });
    } catch (error) {
      logger.error(error, 'Failed to create sessions directory');
    }
  }

  async startSession(sessionId: string): Promise<string> {
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!;
      if (existing.socket) return existing.status;
    }

    try {
      await this.initDir();

      const { state, saveCreds } = await useMultiFileAuthState(
        path.join(SESSIONS_DIR, sessionId)
      );

      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
      });

      const sessionState: SessionState = {
        socket,
        qr: null,
        status: 'connecting',
        me: null,
      };

      this.sessions.set(sessionId, sessionState);

      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const qrDataUrl = await QRCode.toDataURL(qr);
            sessionState.qr = qrDataUrl;
            logger.info({ sessionId }, 'QR generated');
          } catch (error) {
            logger.error(error, 'Failed to generate QR');
          }
        }

        if (connection === 'open') {
          sessionState.qr = null;
          sessionState.status = 'connected';
          sessionState.me = socket.user;
          logger.info({ sessionId, me: socket.user }, 'Connection opened');
          await this.webhookDispatch(sessionId, 'connection.open', {
            me: socket.user,
          });
        }

        if (connection === 'close') {
          const shouldReconnect =
            (lastDisconnect?.error as any)?.output?.statusCode !==
            DisconnectReason.loggedOut;
          sessionState.status = 'disconnected';
          logger.info({ sessionId, shouldReconnect }, 'Connection closed');

          if (shouldReconnect) {
            await this.startSession(sessionId);
          } else {
            this.sessions.delete(sessionId);
            await this.webhookDispatch(sessionId, 'connection.close', {});
          }
        }
      });

      socket.ev.on('messages.upsert', async (m) => {
        for (const msg of m.messages) {
          logger.info({ sessionId, msgId: msg.key.id }, 'Message received');
          await this.webhookDispatch(sessionId, 'message.received', {
            message: msg,
          });
        }
      });

      socket.ev.on('messages.update', async (m) => {
        for (const { key, update } of m) {
          logger.info({ sessionId, msgId: key.id }, 'Message updated');
          await this.webhookDispatch(sessionId, 'message.update', {
            key,
            update,
          });
        }
      });

      socket.ev.on('creds.update', saveCreds);

      return 'connecting';
    } catch (error) {
      logger.error(error, 'Failed to start session');
      throw error;
    }
  }

  async getQR(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    return session?.qr || null;
  }

  async getStatus(
    sessionId: string
  ): Promise<{ status: string; me: any }> {
    const session = this.sessions.get(sessionId);
    return {
      status: session?.status || 'disconnected',
      me: session?.me,
    };
  }

  async logout(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session?.socket) {
      try {
        await session.socket.logout();
        logger.info({ sessionId }, 'Logged out');
      } catch (error) {
        logger.error(error, 'Failed to logout from socket');
      }
    }
    this.sessions.delete(sessionId);

    try {
      await fs.rm(path.join(SESSIONS_DIR, sessionId), { recursive: true });
      logger.info({ sessionId }, 'Session directory deleted');
    } catch (error) {
      logger.error(error, 'Failed to delete session directory');
    }
  }

  async sendMessage(
    sessionId: string,
    to: string,
    text: string
  ): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not found or not connected');
    }

    try {
      const msg = await session.socket.sendMessage(to, { text });
      const messageId = msg?.key?.id || undefined;
      logger.info({ sessionId, to, msgId: messageId }, 'Message sent');
      return messageId;
    } catch (error) {
      logger.error(error, 'Failed to send message');
      throw error;
    }
  }

  async sendMedia(
    sessionId: string,
    to: string,
    mediaUrl: string,
    caption?: string,
    type?: string
  ): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not found or not connected');
    }

    try {
      const mediaType = (type || 'image') as string;
      const response = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const messageContent: AnyMessageContent = {
        [mediaType]: response.data,
        caption,
      } as AnyMessageContent;

      const msg = await session.socket.sendMessage(to, messageContent);
      const messageId = msg?.key?.id || undefined;

      logger.info(
        { sessionId, to, msgId: messageId, type: mediaType },
        'Media sent'
      );
      return messageId;
    } catch (error) {
      logger.error(error, 'Failed to send media');
      throw error;
    }
  }

  private async webhookDispatch(
    sessionId: string,
    event: string,
    data: any
  ) {
    const url = process.env.WEBHOOK_URL;
    if (!url) return;

    const payload = {
      event,
      sessionId,
      data,
      timestamp: new Date().toISOString(),
    };

    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries) {
      try {
        await axios.post(url, payload, {
          headers: {
            'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });
        logger.info({ sessionId, event }, 'Webhook dispatched');
        return;
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          logger.error(
            { sessionId, event, error, retries },
            'Webhook dispatch failed after retries'
          );
          return;
        }
        const delay = Math.pow(2, retries) * 1000;
        logger.warn(
          { sessionId, event, retries, delay },
          'Webhook dispatch failed, retrying'
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}

