import { DeviceEventEmitter, EmitterSubscription, Permission, PermissionsAndroid, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';

import { Emitter } from './emitter';

/**
 * Ses oturumu (mode, audio focus, BT SCO, proximity) TEK sahibe aittir: InCallManager.
 * expo-audio / expo-av bilinçli olarak kullanılmaz — iki native katman aynı anda
 * MODE_IN_COMMUNICATION ve audio focus'u zorlarsa Android'de rota kilitlenir.
 */

export type AudioRoute = 'SPEAKER_PHONE' | 'EARPIECE' | 'BLUETOOTH' | 'WIRED_HEADSET';

export type AudioRouteState = {
  current: AudioRoute;
  available: AudioRoute[];
};

type Events = { route: AudioRouteState };

const ROUTE_PRIORITY: AudioRoute[] = ['BLUETOOTH', 'WIRED_HEADSET', 'SPEAKER_PHONE', 'EARPIECE'];

export const ROUTE_LABEL: Record<AudioRoute, string> = {
  SPEAKER_PHONE: 'Hoparlör',
  EARPIECE: 'Ahize',
  BLUETOOTH: 'Bluetooth',
  WIRED_HEADSET: 'Kulaklık',
};

function isRoute(v: unknown): v is AudioRoute {
  return v === 'SPEAKER_PHONE' || v === 'EARPIECE' || v === 'BLUETOOTH' || v === 'WIRED_HEADSET';
}

/** Mikrofon + (Android 12+) BLUETOOTH_CONNECT. İzin InCallManager.start()'tan ÖNCE alınmalı,
 *  aksi halde BT cihaz taraması boş döner ve chooseAudioRoute('BLUETOOTH') sessizce başarısız olur. */
export async function requestCallPermissions(): Promise<{ mic: boolean; bluetooth: boolean }> {
  if (Platform.OS !== 'android') return { mic: true, bluetooth: true }; // iOS: getUserMedia sistem diyalogunu açar
  const wanted: Permission[] = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  const needsBtConnect = Number(Platform.Version) >= 31;
  if (needsBtConnect) wanted.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);

  const res = await PermissionsAndroid.requestMultiple(wanted);
  const granted = (p: string) => res[p as keyof typeof res] === PermissionsAndroid.RESULTS.GRANTED;
  return {
    mic: granted(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
    bluetooth: needsBtConnect ? granted(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) : true,
  };
}

class AudioManagerImpl extends Emitter<Events> {
  private active = false;
  private sub: EmitterSubscription | null = null;
  private state: AudioRouteState = { current: 'SPEAKER_PHONE', available: ['SPEAKER_PHONE'] };
  /** Kullanıcı elle rota seçtiyse, cihaz listesi değişmedikçe otomatik seçim yapılmaz. */
  private userPinned = false;
  /** Cihaz seti her değiştiğinde yalnızca BİR kez otomatik seçim (başarısız BT'de döngüyü önler). */
  private needsAutoSelect = true;

  get route(): AudioRouteState {
    return this.state;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.userPinned = false;
    this.needsAutoSelect = true;

    if (Platform.OS === 'android') {
      this.sub = DeviceEventEmitter.addListener('onAudioDeviceChanged', (e) => this.onDeviceChanged(e));
    }

    // auto: true → Android'de proximity yalnızca rota EARPIECE iken ekranı kapatır,
    // hoparlör/BT'de ekran açık kalır (yanak teması sorunu yaşanmaz).
    InCallManager.start({ media: 'audio', auto: true });
    InCallManager.setKeepScreenOn(true);

    if (Platform.OS === 'ios') {
      // iOS: BT (HFP) WebRTC'nin AVAudioSession'ı (AllowBluetooth) ile sistem tarafından seçilir.
      InCallManager.setForceSpeakerphoneOn(true);
      this.setState({ current: 'SPEAKER_PHONE', available: ['SPEAKER_PHONE', 'EARPIECE'] });
    }
    // Android: ilk onAudioDeviceChanged olayı cihaz listesini getirir; varsayılan rota orada seçilir.
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.sub?.remove();
    this.sub = null;
    if (Platform.OS === 'ios') InCallManager.setForceSpeakerphoneOn(false);
    InCallManager.setKeepScreenOn(false);
    InCallManager.stop();
  }

  async setRoute(route: AudioRoute, byUser = true): Promise<void> {
    if (!this.active) return;
    if (byUser) this.userPinned = true;

    if (Platform.OS === 'ios') {
      InCallManager.setForceSpeakerphoneOn(route === 'SPEAKER_PHONE');
      this.setState({ ...this.state, current: route });
      return;
    }

    try {
      const res = await InCallManager.chooseAudioRoute(route);
      this.onDeviceChanged(res);
    } catch (e) {
      console.warn('[audio] chooseAudioRoute failed', e);
    }
  }

  /** Buton: mevcut rotadan bir sonrakine geçer (öncelik sırası: BT → Kablolu → Hoparlör → Ahize). */
  cycleRoute(): void {
    const order = ROUTE_PRIORITY.filter((r) => this.state.available.includes(r));
    if (order.length < 2) return;
    const next = order[(order.indexOf(this.state.current) + 1) % order.length];
    void this.setRoute(next);
  }

  private onDeviceChanged(e: { availableAudioDeviceList?: string; selectedAudioDevice?: string } | undefined): void {
    if (!e) return;
    let available: AudioRoute[] = this.state.available;
    try {
      const list: unknown = JSON.parse(e.availableAudioDeviceList ?? '[]');
      if (Array.isArray(list)) available = list.filter(isRoute);
    } catch {
      /* eski liste korunur */
    }
    if (!available.includes('SPEAKER_PHONE')) available = [...available, 'SPEAKER_PHONE'];

    const deviceSetChanged =
      available.length !== this.state.available.length || available.some((r) => !this.state.available.includes(r));
    const selected = isRoute(e.selectedAudioDevice) ? e.selectedAudioDevice : this.state.current;

    this.setState({ current: selected, available });

    // Yeni cihaz bağlandı/koptu → kullanıcı sabitlemesini bırak, en iyi rotaya geç.
    // Varsayılan: BT > kablolu > hoparlör (ahize asla otomatik seçilmez = playThroughEarpiece: false).
    if (deviceSetChanged) {
      this.userPinned = false;
      this.needsAutoSelect = true;
    }
    if (this.needsAutoSelect && !this.userPinned) {
      this.needsAutoSelect = false;
      const best = ROUTE_PRIORITY.find((r) => r !== 'EARPIECE' && available.includes(r)) ?? 'SPEAKER_PHONE';
      if (best !== selected) void this.setRoute(best, false);
    }
  }

  private setState(s: AudioRouteState): void {
    this.state = s;
    this.emit('route', s);
  }
}

export const AudioManager = new AudioManagerImpl();
