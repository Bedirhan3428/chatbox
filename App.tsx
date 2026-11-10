import { useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { ControlButton, IconName } from './components/ControlButton';
import { StatusBadge } from './components/StatusBadge';
import { colors, MIN_TOUCH } from './components/theme';
import { useCall } from './hooks/useCall';
import { AudioRoute, ROUTE_LABEL } from './services/audioManager';
import type { PeerView } from './services/webrtc';

const ROOM_RE = /^[a-zA-Z0-9_-]{3,32}$/;

const ROUTE_ICON: Record<AudioRoute, IconName> = {
  SPEAKER_PHONE: 'volume-high',
  EARPIECE: 'phone',
  BLUETOOTH: 'bluetooth-audio',
  WIRED_HEADSET: 'headphones',
};

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const call = useCall();
  return call.inCall ? <CallScreen call={call} /> : <JoinScreen call={call} />;
}

type Call = ReturnType<typeof useCall>;

// ---------------------------------------------------------------- Giriş

function JoinScreen({ call }: { call: Call }) {
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = ROOM_RE.test(roomId.trim());

  const onJoin = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await call.join(roomId, name);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.joinWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text style={styles.title}>Sesli Oda</Text>
        <Text style={styles.subtitle}>P2P · uçtan uca şifreli · en fazla 4 kişi</Text>

        <View style={styles.form}>
          <Text style={styles.inputLabel}>Oda ID</Text>
          <TextInput
            value={roomId}
            onChangeText={setRoomId}
            placeholder="ornek-oda"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={32}
            style={styles.input}
            returnKeyType="next"
          />
          <Text style={styles.inputLabel}>İsim</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Misafir"
            placeholderTextColor={colors.textDim}
            maxLength={24}
            style={styles.input}
            returnKeyType="go"
            onSubmitEditing={onJoin}
          />
          {roomId.length > 0 && !valid ? (
            <Text style={styles.hint}>3–32 karakter: harf, rakam, - veya _</Text>
          ) : null}
          {call.error ? <Text style={styles.error}>{call.error}</Text> : null}
        </View>

        <View style={styles.primaryClip}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Odaya katıl"
            accessibilityState={{ disabled: !valid || busy }}
            disabled={!valid || busy}
            onPress={onJoin}
            android_ripple={{ color: 'rgba(0,0,0,0.15)' }}
            style={({ pressed }) => [
              styles.primary,
              { opacity: !valid || busy ? 0.4 : Platform.OS === 'ios' && pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={styles.primaryText}>{busy ? 'Hazırlanıyor…' : 'Katıl'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- Arama

function CallScreen({ call }: { call: Call }) {
  const { status, peers, local, muted, pttMode, route } = call;
  const routeLabel = ROUTE_LABEL[route.current];
  const canCycle = route.available.length > 1;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* Üst bölge: yalnızca bilgi — kulağa/yanağa değebilecek alanda dokunmatik hedef yok. */}
      <View style={styles.header}>
        <StatusBadge status={status} />
        {call.error ? <Text style={[styles.error, styles.center]}>{call.error}</Text> : null}
        {call.btDenied ? (
          <Text style={[styles.hint, styles.center]}>Bluetooth izni verilmedi; BT kulaklık listelenmez.</Text>
        ) : null}
      </View>

      <FlatList
        data={peers}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.peerList}
        renderItem={({ item }) => <PeerRow peer={item} />}
        ListHeaderComponent={<SelfRow muted={muted} pttMode={pttMode} live={local.micLive} speaking={local.transmitting} />}
        ListEmptyComponent={<Text style={[styles.hint, styles.center]}>Diğer katılımcılar bekleniyor…</Text>}
      />

      {/* Alt "thumb zone": tüm kontroller burada. */}
      <View style={styles.controls}>
        {pttMode ? (
          <View style={styles.pttClip}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Konuşmak için basılı tut"
              disabled={muted}
              onPressIn={() => call.setTalking(true)}
              onPressOut={() => call.setTalking(false)}
              pressRetentionOffset={{ top: 200, bottom: 200, left: 200, right: 200 }}
              android_ripple={{ color: colors.ripple }}
              style={[
                styles.ptt,
                local.micLive && styles.pttLive,
                muted && { opacity: 0.4 },
              ]}
            >
              <Text style={[styles.pttText, local.micLive && { color: colors.bg }]}>
                {muted ? 'Mikrofon kapalı' : local.micLive ? 'Konuşuyorsun' : 'Bas ve Konuş'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.row}>
          <ControlButton
            label={muted ? 'Mikrofonu aç' : 'Sustur'}
            icon={muted ? 'microphone-off' : 'microphone'}
            caption={muted ? 'Kapalı' : 'Mikrofon'}
            active={muted}
            onPress={call.toggleMute}
          />
          <ControlButton
            label="Konuşma modu"
            icon={pttMode ? 'gesture-tap-hold' : 'phone-in-talk'}
            caption={pttMode ? 'Bas-Konuş' : 'Sürekli'}
            active={pttMode}
            onPress={call.togglePttMode}
          />
          <ControlButton
            label="Ses çıkışı"
            icon={ROUTE_ICON[route.current]}
            caption={routeLabel}
            disabled={!canCycle}
            onPress={call.cycleRoute}
          />
          <ControlButton label="Aramadan ayrıl" icon="phone-hangup" caption="Ayrıl" tone="danger" onPress={call.leave} />
        </View>
      </View>
    </SafeAreaView>
  );
}

function SelfRow({ muted, pttMode, live, speaking }: { muted: boolean; pttMode: boolean; live: boolean; speaking: boolean }) {
  const sub = muted ? 'Susturuldu' : pttMode && !live ? 'Bas-Konuş bekliyor' : 'Mikrofon açık';
  return <Row name="Sen" sub={sub} speaking={speaking} dim={!live} />;
}

const PEER_STATE_TEXT: Record<PeerView['state'], string> = {
  new: 'Bekleniyor',
  connecting: 'Bağlanıyor',
  connected: 'Bağlı',
  reconnecting: 'Yeniden bağlanıyor',
  failed: 'Bağlantı koptu',
};

function PeerRow({ peer }: { peer: PeerView }) {
  return (
    <Row
      name={peer.name}
      sub={PEER_STATE_TEXT[peer.state]}
      speaking={peer.speaking}
      dim={peer.state !== 'connected'}
    />
  );
}

function Row({ name, sub, speaking, dim }: { name: string; sub: string; speaking: boolean; dim: boolean }) {
  return (
    <View style={[styles.peer, speaking && styles.peerSpeaking]}>
      <View style={[styles.avatar, speaking && { borderColor: colors.success }]}>
        <Text style={styles.avatarText}>{name.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.peerName, dim && { color: colors.textDim }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.peerSub}>{speaking ? 'Konuşuyor' : sub}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Stil

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { textAlign: 'center' },

  joinWrap: { flex: 1, paddingHorizontal: 24, justifyContent: 'flex-end', paddingBottom: 24 },
  title: { color: colors.text, fontSize: 32, fontWeight: '700' },
  subtitle: { color: colors.textDim, fontSize: 14, marginTop: 6 },
  form: { marginTop: 32, marginBottom: 24, gap: 8 },
  inputLabel: { color: colors.textDim, fontSize: 13, marginTop: 8 },
  input: {
    minHeight: MIN_TOUCH,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  hint: { color: colors.textDim, fontSize: 13, marginTop: 4 },
  error: { color: colors.danger, fontSize: 14, marginTop: 8 },
  primaryClip: { borderRadius: 16, overflow: 'hidden' },
  primary: { minHeight: MIN_TOUCH, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: colors.bg, fontSize: 17, fontWeight: '700' },

  header: { paddingTop: 16, paddingHorizontal: 24, gap: 8 },
  peerList: { padding: 20, gap: 10, flexGrow: 1 },
  peer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  peerSpeaking: { borderColor: colors.success },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  avatarText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  peerName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  peerSub: { color: colors.textDim, fontSize: 13, marginTop: 2 },

  controls: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    gap: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  row: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-start' },
  pttClip: { borderRadius: 24, overflow: 'hidden' },
  ptt: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceHi,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 24,
  },
  pttLive: { backgroundColor: colors.success, borderColor: colors.success },
  pttText: { color: colors.text, fontSize: 18, fontWeight: '700' },
});
