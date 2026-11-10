import { env } from '../config/env';
import { Emitter } from './emitter';

export type PeerInfo = { id: string; name: string };

export type SignalData =
  | { description: { type: 'offer' | 'answer'; sdp: string } }
  | { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } };

export type ClientMessage =
  | { type: 'join'; roomId: string; name: string }
  | { type: 'leave' }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | { type: 'joined'; selfId: string; roomId: string; peers: PeerInfo[] }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; id: string }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'pong'; t: number }
  | { type: 'error'; code: 'ROOM_FULL' | 'BAD_REQUEST' | 'NOT_IN_ROOM'; message?: string };

export type SignalingState = 'idle' | 'connecting' | 'waking' | 'open' | 'closed';

type Events = {
  state: SignalingState;
  joined: Extract<ServerMessage, { type: 'joined' }>;
  'peer-joined': PeerInfo;
  'peer-left': string;
  signal: { from: string; data: SignalData };
  error: { code: string; message?: string };
};

/** Render free tier: ilk istek uykudaki instance'ı uyandırır (~30-60 sn). */
const WAKING_AFTER_MS = 4_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

export class SignalingClient extends Emitter<Events> {
  private ws: WebSocket | null = null;
  private state: SignalingState = 'idle';
  private shouldRun = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wakingTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: ClientMessage[] = [];
  private room: { roomId: string; name: string } | null = null;

  constructor(private readonly url: string = env.signalingUrl) {
    super();
  }

  get currentState(): SignalingState {
    return this.state;
  }

  connect(roomId: string, name: string): void {
    this.room = { roomId, name };
    this.shouldRun = true;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.shouldRun = false;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendRaw({ type: 'leave' });
    this.room = null;
    this.queue = [];
    this.teardownSocket();
    this.setState('idle');
  }

  /** Bağlantı yoksa kuyruğa alır; signal mesajları yeniden bağlanınca anlamsız olacağı için kuyruk sınırlıdır. */
  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
    } else if (this.queue.length < 64) {
      this.queue.push(msg);
    }
  }

  private open(): void {
    this.teardownSocket();
    this.setState('connecting');
    this.wakingTimer = setTimeout(() => {
      if (this.state === 'connecting') this.setState('waking');
    }, WAKING_AFTER_MS);

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearWaking();
      this.attempt = 0;
      this.setState('open');
      this.startHeartbeat();
      // Yeniden bağlanmada sunucu yeni bir selfId verir; eski signal mesajları geçersizdir.
      this.queue = this.queue.filter((m) => m.type !== 'signal' && m.type !== 'join');
      if (this.room) this.sendRaw({ type: 'join', ...this.room });
      const pending = this.queue;
      this.queue = [];
      pending.forEach((m) => this.sendRaw(m));
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onerror = () => {
      // onclose her zaman ardından gelir; yeniden bağlanma orada yönetilir.
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.teardownSocket();
      if (!this.shouldRun) return;
      this.setState('closed');
      this.scheduleReconnect();
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      case 'joined':
        this.emit('joined', msg);
        return;
      case 'peer-joined':
        this.emit('peer-joined', msg.peer);
        return;
      case 'peer-left':
        this.emit('peer-left', msg.id);
        return;
      case 'signal':
        this.emit('signal', { from: msg.from, data: msg.data });
        return;
      case 'error':
        if (msg.code === 'ROOM_FULL') this.shouldRun = false;
        this.emit('error', { code: msg.code, message: msg.message });
        return;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.sendRaw({ type: 'ping', t: Date.now() });
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        // Yarı açık TCP (NAT timeout, ağ değişimi): soketi kapat, onclose yeniden bağlar.
        this.ws?.close();
      }, env.heartbeatTimeoutMs);
    }, env.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldRun) this.open();
    }, delay);
  }

  private sendRaw(msg: ClientMessage): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (e) {
      console.warn('[signaling] send failed', e);
    }
  }

  private clearWaking(): void {
    if (this.wakingTimer) clearTimeout(this.wakingTimer);
    this.wakingTimer = null;
  }

  private teardownSocket(): void {
    this.clearWaking();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.reconnectTimer = this.heartbeatTimer = this.pongTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }

  private setState(s: SignalingState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }
}
