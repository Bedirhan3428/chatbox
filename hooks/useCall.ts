import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { AudioManager, AudioRouteState, requestCallPermissions } from '../services/audioManager';
import { SignalingState } from '../services/signaling';
import { CallEngine, LocalView, PeerView } from '../services/webrtc';

export type CallStatus = 'idle' | 'connecting' | 'waking' | 'in-room' | 'transmitting' | 'error';

const KEEP_AWAKE_TAG = 'call';

const ERROR_TEXT: Record<string, string> = {
  ROOM_FULL: 'Oda dolu (en fazla 4 kişi).',
  BAD_REQUEST: 'Geçersiz oda bilgisi.',
  MIC_DENIED: 'Mikrofon izni verilmedi.',
  MEDIA_FAILED: 'Mikrofon başlatılamadı.',
};

export function useCall() {
  const engine = useRef<CallEngine | null>(null);
  if (!engine.current) engine.current = new CallEngine();

  const [inCall, setInCall] = useState(false);
  const [signaling, setSignaling] = useState<SignalingState>('idle');
  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [local, setLocal] = useState<LocalView>({ micLive: true, transmitting: false });
  const [error, setError] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [pttMode, setPttModeState] = useState(false);
  const [route, setRoute] = useState<AudioRouteState>(AudioManager.route);
  const [btDenied, setBtDenied] = useState(false);

  useEffect(() => {
    const e = engine.current!;
    const unsubs = [
      e.on('signaling', (s) => {
        setSignaling(s);
        if (s !== 'open') setJoined(false);
      }),
      e.on('joined', () => {
        setJoined(true);
        setError(null);
      }),
      e.on('peers', setPeers),
      e.on('local', setLocal),
      e.on('error', (err) => setError(ERROR_TEXT[err.code] ?? err.message ?? err.code)),
      AudioManager.on('route', setRoute),
    ];
    return () => {
      unsubs.forEach((u) => u());
      void e.leave();
      AudioManager.stop();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, []);

  // PTT basılıyken uygulama arka plana düşerse mikrofonu kapat (takılı kalan "basılı" durumunu önler).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') engine.current?.setTalking(false);
    });
    return () => sub.remove();
  }, []);

  const join = useCallback(async (roomId: string, name: string) => {
    setError(null);
    const perms = await requestCallPermissions();
    if (!perms.mic) {
      setError(ERROR_TEXT.MIC_DENIED);
      return;
    }
    setBtDenied(!perms.bluetooth);

    // Sıra önemli: izinler → ses oturumu (InCallManager) → getUserMedia.
    AudioManager.start();
    try {
      await engine.current!.join(roomId.trim(), name.trim() || 'Misafir');
      setMutedState(false);
      setPttModeState(false);
      setInCall(true);
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    } catch (e) {
      console.warn('[call] join failed', e);
      AudioManager.stop();
      setError(ERROR_TEXT.MEDIA_FAILED);
    }
  }, []);

  const leave = useCallback(async () => {
    await engine.current!.leave();
    AudioManager.stop();
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    setInCall(false);
    setJoined(false);
    setPeers([]);
    setError(null);
  }, []);

  const toggleMute = useCallback(() => {
    setMutedState((m) => {
      engine.current!.setMuted(!m);
      return !m;
    });
  }, []);

  const togglePttMode = useCallback(() => {
    setPttModeState((p) => {
      engine.current!.setPushToTalkMode(!p);
      return !p;
    });
  }, []);

  const setTalking = useCallback((pressed: boolean) => engine.current!.setTalking(pressed), []);
  const cycleRoute = useCallback(() => AudioManager.cycleRoute(), []);

  const status: CallStatus = useMemo(() => {
    if (error) return 'error';
    if (!inCall || signaling === 'idle') return 'idle';
    if (signaling === 'waking') return 'waking';
    if (signaling !== 'open' || !joined) return 'connecting';
    return local.transmitting ? 'transmitting' : 'in-room';
  }, [error, inCall, signaling, joined, local.transmitting]);

  return {
    status,
    inCall,
    peers,
    local,
    error,
    muted,
    pttMode,
    route,
    btDenied,
    join,
    leave,
    toggleMute,
    togglePttMode,
    setTalking,
    cycleRoute,
  };
}
