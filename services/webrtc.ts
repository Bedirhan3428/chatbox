import {
  MediaStream,
  MediaStreamTrack,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';

import { env } from '../config/env';
import { Emitter } from './emitter';
import { PeerInfo, SignalData, SignalingClient, SignalingState } from './signaling';

export type PeerConnState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type PeerView = {
  id: string;
  name: string;
  state: PeerConnState;
  speaking: boolean;
};

export type LocalView = {
  /** Mikrofon track'i şu an açık mı (mute + PTT hesaba katılmış). */
  micLive: boolean;
  /** Yerel ses seviyesi eşiği aşıyor ve en az bir peer'e bağlıyız. */
  transmitting: boolean;
};

type Events = {
  signaling: SignalingState;
  joined: { selfId: string; roomId: string };
  peers: PeerView[];
  local: LocalView;
  error: { code: string; message?: string };
};

type Peer = {
  info: PeerInfo;
  pc: RTCPeerConnection;
  /** Perfect negotiation: çakışmada kendi offer'ını geri alıp karşı tarafınkini kabul eden taraf. */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  tracksAdded: boolean;
  pendingCandidates: RTCIceCandidate[];
  state: PeerConnState;
  speaking: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  remoteStream: MediaStream | null;
};

const DISCONNECT_GRACE_MS = 4_000;

export class CallEngine extends Emitter<Events> {
  private readonly signaling: SignalingClient;
  private readonly peers = new Map<string, Peer>();
  private localStream: MediaStream | null = null;
  private selfId: string | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private statsBusy = false;
  private unsubs: Array<() => void> = [];

  private muted = false;
  private pttMode = false;
  private pttPressed = false;
  private transmitting = false;

  constructor(signaling = new SignalingClient()) {
    super();
    this.signaling = signaling;
  }

  // ---------- Yaşam döngüsü ----------

  async join(roomId: string, name: string): Promise<void> {
    await this.leave();

    this.localStream = await mediaDevices.getUserMedia({ audio: true, video: false });
    this.applyMicState();

    this.unsubs = [
      this.signaling.on('state', (s) => this.emit('signaling', s)),
      this.signaling.on('joined', (m) => this.onJoined(m.selfId, m.roomId, m.peers)),
      this.signaling.on('peer-joined', (p) => this.onPeerJoined(p)),
      this.signaling.on('peer-left', (id) => this.removePeer(id)),
      this.signaling.on('signal', ({ from, data }) => void this.onSignal(from, data)),
      this.signaling.on('error', (e) => this.emit('error', e)),
    ];

    this.signaling.connect(roomId, name);
    this.startStats();
  }

  async leave(): Promise<void> {
    this.stopStats();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.signaling.disconnect();
    [...this.peers.keys()].forEach((id) => this.removePeer(id, false));
    this.emitPeers();

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream.release();
      this.localStream = null;
    }
    this.selfId = null;
    this.pttPressed = false;
    this.setTransmitting(false);
  }

  // ---------- Mikrofon kontrolleri (renegotiation YOK, sadece track.enabled) ----------

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMicState();
  }

  setPushToTalkMode(enabled: boolean): void {
    this.pttMode = enabled;
    this.pttPressed = false;
    this.applyMicState();
  }

  setTalking(pressed: boolean): void {
    if (!this.pttMode) return;
    this.pttPressed = pressed;
    this.applyMicState();
  }

  private get localTrack(): MediaStreamTrack | undefined {
    return this.localStream?.getAudioTracks()[0];
  }

  private get micLive(): boolean {
    return !this.muted && (!this.pttMode || this.pttPressed);
  }

  private applyMicState(): void {
    const track = this.localTrack;
    if (track) track.enabled = this.micLive;
    if (!this.micLive) this.setTransmitting(false);
    this.emitLocal();
  }

  // ---------- Signaling olayları ----------

  private onJoined(selfId: string, roomId: string, existing: PeerInfo[]): void {
    // Yeniden bağlanmada yeni selfId gelir: eski PC'ler artık eşleşmez, temiz başla.
    [...this.peers.keys()].forEach((id) => this.removePeer(id, false));
    this.selfId = selfId;
    this.emit('joined', { selfId, roomId });

    // Yeni katılan taraf mevcut herkese offer başlatır (track ekleme → negotiationneeded).
    existing.forEach((info) => {
      const peer = this.createPeer(info);
      this.addLocalTracks(peer);
    });
    this.emitPeers();
  }

  private onPeerJoined(info: PeerInfo): void {
    if (this.peers.has(info.id)) return;
    // Mevcut taraf track eklemeden bekler; offer gelince SRD sonrası track eklenir,
    // böylece iki taraf aynı anda offer üretmez.
    this.createPeer(info);
    this.emitPeers();
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    let peer = this.peers.get(from);
    if (!peer) {
      // peer-joined'dan önce gelen signal (yarış) — PC'yi tembel oluştur.
      peer = this.createPeer({ id: from, name: 'Katılımcı' });
      this.emitPeers();
    }
    const { pc } = peer;

    try {
      if ('description' in data) {
        const desc = new RTCSessionDescription(data.description);
        const offerCollision =
          desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        if (offerCollision) {
          // Polite taraf: kendi offer'ını geri al, karşı tarafınkini kabul et.
          await pc.setLocalDescription({ type: 'rollback', sdp: '' });
        }

        await pc.setRemoteDescription(desc);
        await this.flushCandidates(peer);

        if (desc.type === 'offer') {
          this.addLocalTracks(peer);
          await pc.setLocalDescription();
          this.sendDescription(peer);
        }
      } else if ('candidate' in data) {
        const candidate = new RTCIceCandidate(data.candidate);
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(candidate);
          return;
        }
        await pc.addIceCandidate(candidate);
      }
    } catch (e) {
      if (!peer.ignoreOffer) console.warn(`[webrtc] signal from ${from} failed`, e);
    }
  }

  // ---------- Peer connection ----------

  private createPeer(info: PeerInfo): Peer {
    this.removePeer(info.id, false);

    const pc = new RTCPeerConnection(env.rtcConfig);
    const peer: Peer = {
      info,
      pc,
      polite: (this.selfId ?? '') < info.id,
      makingOffer: false,
      ignoreOffer: false,
      tracksAdded: false,
      pendingCandidates: [],
      state: 'new',
      speaking: false,
      disconnectTimer: null,
      remoteStream: null,
    };
    this.peers.set(info.id, peer);

    pc.addEventListener('negotiationneeded', async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription(peer);
      } catch (e) {
        console.warn(`[webrtc] negotiation with ${info.id} failed`, e);
      } finally {
        peer.makingOffer = false;
      }
    });

    pc.addEventListener('icecandidate', (ev) => {
      const c = ev.candidate;
      if (!c) return;
      this.signaling.send({
        type: 'signal',
        to: info.id,
        data: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } },
      });
    });

    pc.addEventListener('track', (ev) => {
      // react-native-webrtc uzak ses track'ini otomatik çalar; referansı temizlik için tutuyoruz.
      peer.remoteStream = ev.streams[0] ?? null;
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      switch (pc.iceConnectionState) {
        case 'checking':
          this.setPeerState(peer, peer.state === 'connected' ? 'reconnecting' : 'connecting');
          break;
        case 'connected':
        case 'completed':
          if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
          peer.disconnectTimer = null;
          this.setPeerState(peer, 'connected');
          break;
        case 'disconnected':
          // Ağ geçişi (Wi-Fi ↔ hücresel) çoğu zaman kendiliğinden toparlanır; kısa süre bekle.
          this.setPeerState(peer, 'reconnecting');
          if (!peer.disconnectTimer) {
            peer.disconnectTimer = setTimeout(() => {
              peer.disconnectTimer = null;
              if (pc.iceConnectionState === 'disconnected') pc.restartIce();
            }, DISCONNECT_GRACE_MS);
          }
          break;
        case 'failed':
          this.setPeerState(peer, 'reconnecting');
          pc.restartIce();
          break;
        case 'closed':
          break;
      }
    });

    return peer;
  }

  private addLocalTracks(peer: Peer): void {
    if (peer.tracksAdded || !this.localStream) return;
    this.localStream.getTracks().forEach((t) => peer.pc.addTrack(t, this.localStream!));
    peer.tracksAdded = true;
  }

  private sendDescription(peer: Peer): void {
    const d = peer.pc.localDescription;
    if (!d || (d.type !== 'offer' && d.type !== 'answer')) return;
    this.signaling.send({ type: 'signal', to: peer.info.id, data: { description: { type: d.type, sdp: d.sdp } } });
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const pending = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of pending) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch (e) {
        console.warn('[webrtc] queued candidate rejected', e);
      }
    }
  }

  private removePeer(id: string, emit = true): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    peer.remoteStream?.release(false);
    peer.pc.close();
    this.peers.delete(id);
    if (emit) this.emitPeers();
  }

  private setPeerState(peer: Peer, state: PeerConnState): void {
    if (peer.state === state) return;
    peer.state = state;
    if (state !== 'connected') peer.speaking = false;
    this.emitPeers();
  }

  // ---------- Ses seviyesi (1 sn aralık; bridge yükünü düşük tutar) ----------

  private startStats(): void {
    this.stopStats();
    this.statsTimer = setInterval(() => void this.pollStats(), env.statsIntervalMs);
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private async pollStats(): Promise<void> {
    if (this.statsBusy) return;
    this.statsBusy = true;
    try {
      let localLevel = 0;
      let localMeasured = false;
      let changed = false;

      for (const peer of this.peers.values()) {
        if (peer.state !== 'connected') continue;
        const report: Map<string, any> = await peer.pc.getStats();
        let remoteLevel = 0;
        report.forEach((s) => {
          if (s.kind !== 'audio' && s.mediaType !== 'audio') return;
          if (s.type === 'inbound-rtp' && typeof s.audioLevel === 'number') remoteLevel = s.audioLevel;
          if (!localMeasured && s.type === 'media-source' && typeof s.audioLevel === 'number') {
            localLevel = s.audioLevel;
            localMeasured = true;
          }
        });
        const speaking = remoteLevel > env.speakingThreshold;
        if (speaking !== peer.speaking) {
          peer.speaking = speaking;
          changed = true;
        }
      }

      if (changed) this.emitPeers();
      this.setTransmitting(this.micLive && localMeasured && localLevel > env.speakingThreshold);
    } catch {
      // PC kapanırken getStats reddedebilir — sessizce geç.
    } finally {
      this.statsBusy = false;
    }
  }

  // ---------- Emit yardımcıları ----------

  private setTransmitting(v: boolean): void {
    if (this.transmitting === v) return;
    this.transmitting = v;
    this.emitLocal();
  }

  private emitLocal(): void {
    this.emit('local', { micLive: this.micLive, transmitting: this.transmitting });
  }

  private emitPeers(): void {
    this.emit(
      'peers',
      [...this.peers.values()].map((p) => ({
        id: p.info.id,
        name: p.info.name,
        state: p.state,
        speaking: p.speaking,
      })),
    );
  }
}
