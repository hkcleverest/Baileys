"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const qrcode_1 = __importDefault(require("qrcode"));
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("./logger");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/data/sessions';
class SessionManager {
    constructor() {
        this.sessions = new Map();
    }
    async initDir() {
        try {
            await fs.mkdir(SESSIONS_DIR, { recursive: true });
        }
        catch (error) {
            logger_1.logger.error(error, 'Failed to create sessions directory');
        }
    }
    async startSession(sessionId) {
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            if (existing.socket)
                return existing.status;
        }
        try {
            await this.initDir();
            const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(path.join(SESSIONS_DIR, sessionId));
            const socket = (0, baileys_1.default)({
                auth: state,
                printQRInTerminal: false,
            });
            const sessionState = {
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
                        const qrDataUrl = await qrcode_1.default.toDataURL(qr);
                        sessionState.qr = qrDataUrl;
                        logger_1.logger.info({ sessionId }, 'QR generated');
                    }
                    catch (error) {
                        logger_1.logger.error(error, 'Failed to generate QR');
                    }
                }
                if (connection === 'open') {
                    sessionState.qr = null;
                    sessionState.status = 'connected';
                    sessionState.me = socket.user;
                    logger_1.logger.info({ sessionId, me: socket.user }, 'Connection opened');
                    await this.webhookDispatch(sessionId, 'connection.open', {
                        me: socket.user,
                    });
                }
                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !==
                        baileys_1.DisconnectReason.loggedOut;
                    sessionState.status = 'disconnected';
                    logger_1.logger.info({ sessionId, shouldReconnect }, 'Connection closed');
                    if (shouldReconnect) {
                        await this.startSession(sessionId);
                    }
                    else {
                        this.sessions.delete(sessionId);
                        await this.webhookDispatch(sessionId, 'connection.close', {});
                    }
                }
            });
            socket.ev.on('messages.upsert', async (m) => {
                for (const msg of m.messages) {
                    logger_1.logger.info({ sessionId, msgId: msg.key.id }, 'Message received');
                    await this.webhookDispatch(sessionId, 'message.received', {
                        message: msg,
                    });
                }
            });
            socket.ev.on('messages.update', async (m) => {
                for (const { key, update } of m) {
                    logger_1.logger.info({ sessionId, msgId: key.id }, 'Message updated');
                    await this.webhookDispatch(sessionId, 'message.update', {
                        key,
                        update,
                    });
                }
            });
            socket.ev.on('creds.update', saveCreds);
            return 'connecting';
        }
        catch (error) {
            logger_1.logger.error(error, 'Failed to start session');
            throw error;
        }
    }
    async getQR(sessionId) {
        const session = this.sessions.get(sessionId);
        return session?.qr || null;
    }
    async getStatus(sessionId) {
        const session = this.sessions.get(sessionId);
        return {
            status: session?.status || 'disconnected',
            me: session?.me,
        };
    }
    async logout(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session?.socket) {
            try {
                await session.socket.logout();
                logger_1.logger.info({ sessionId }, 'Logged out');
            }
            catch (error) {
                logger_1.logger.error(error, 'Failed to logout from socket');
            }
        }
        this.sessions.delete(sessionId);
        try {
            await fs.rm(path.join(SESSIONS_DIR, sessionId), { recursive: true });
            logger_1.logger.info({ sessionId }, 'Session directory deleted');
        }
        catch (error) {
            logger_1.logger.error(error, 'Failed to delete session directory');
        }
    }
    async sendMessage(sessionId, to, text) {
        const session = this.sessions.get(sessionId);
        if (!session?.socket) {
            throw new Error('Session not found or not connected');
        }
        try {
            const msg = await session.socket.sendMessage(to, { text });
            const messageId = msg?.key?.id || undefined;
            logger_1.logger.info({ sessionId, to, msgId: messageId }, 'Message sent');
            return messageId;
        }
        catch (error) {
            logger_1.logger.error(error, 'Failed to send message');
            throw error;
        }
    }
    async sendMedia(sessionId, to, mediaUrl, caption, type) {
        const session = this.sessions.get(sessionId);
        if (!session?.socket) {
            throw new Error('Session not found or not connected');
        }
        try {
            const mediaType = (type || 'image');
            const response = await axios_1.default.get(mediaUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
            });
            const messageContent = {
                [mediaType]: response.data,
                caption,
            };
            const msg = await session.socket.sendMessage(to, messageContent);
            const messageId = msg?.key?.id || undefined;
            logger_1.logger.info({ sessionId, to, msgId: messageId, type: mediaType }, 'Media sent');
            return messageId;
        }
        catch (error) {
            logger_1.logger.error(error, 'Failed to send media');
            throw error;
        }
    }
    async webhookDispatch(sessionId, event, data) {
        const url = process.env.WEBHOOK_URL;
        if (!url)
            return;
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
                await axios_1.default.post(url, payload, {
                    headers: {
                        'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
                        'Content-Type': 'application/json',
                    },
                    timeout: 10000,
                });
                logger_1.logger.info({ sessionId, event }, 'Webhook dispatched');
                return;
            }
            catch (error) {
                retries++;
                if (retries >= maxRetries) {
                    logger_1.logger.error({ sessionId, event, error, retries }, 'Webhook dispatch failed after retries');
                    return;
                }
                const delay = Math.pow(2, retries) * 1000;
                logger_1.logger.warn({ sessionId, event, retries, delay }, 'Webhook dispatch failed, retrying');
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
}
exports.SessionManager = SessionManager;
