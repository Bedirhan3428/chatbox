# Chatbox — P2P sesli oda (Expo + WebRTC)

1v1 ve en fazla 4 kişilik mesh sesli arama. Medya cihazlar arasında doğrudan (DTLS-SRTP) akar; Render'daki `ws` sunucusu yalnızca SDP/ICE iletir.

## Çalıştırma

```bash
npm install
cp .env.example .env              # EXPO_PUBLIC_SIGNALING_URL=wss://<servis>.onrender.com
npx expo run:android --device     # veya: npx eas-cli@latest build --profile development
npm start                         # dev client için Metro
```

Expo Go **çalışmaz** (react-native-webrtc native modül). Mikrofon/Bluetooth testi için fiziksel cihaz kullanın.

Lokal sunucu: `cd server && npm install && npm start` → emülatör `ws://10.0.2.2:8080`, fiziksel cihaz `ws://<bilgisayar-LAN-IP>:8080`.

## Render deploy

Repo'yu bağlayın; `render.yaml` Blueprint'i `server/` klasörünü free web service olarak kurar (`/health` health check). Free plan 15 dk boşta kalınca uyur; istemci ilk bağlantıda "Sunucu uyanıyor" gösterir ve otomatik yeniden dener.

## Sinyal protokolü

| Yön | Mesaj |
|---|---|
| C→S | `join {roomId, name}` · `signal {to, data}` · `leave` · `ping {t}` |
| S→C | `joined {selfId, peers[]}` · `peer-joined {peer}` · `peer-left {id}` · `signal {from, data}` · `pong {t}` · `error {code}` |

`data` = `{description}` veya `{candidate}`. Çakışmalar WebRTC *perfect negotiation* ile çözülür: ID'si küçük olan taraf **polite**'tir ve çakışmada kendi offer'ını `rollback` eder.

## Mimari notları

- **Ses oturumunun tek sahibi InCallManager**'dır (mode, audio focus, BT SCO, proximity). `expo-av`/`expo-audio` bilerek kullanılmaz; iki native katman aynı anda audio focus'u zorlarsa Android'de rota kilitlenir. `playThroughEarpiece: false` karşılığı: varsayılan rota BT > kablolu > hoparlör, ahize asla otomatik seçilmez.
- **Mute / Bas-Konuş** yalnızca `track.enabled` değiştirir; track kaldırılmaz → renegotiation yok.
- **Proximity**: ekran yalnızca rota *Ahize* iken kararır; hoparlör/BT'de açık kalır. Tüm kontroller alt bölgede.
- **Android 12+** `BLUETOOTH_CONNECT` izni `InCallManager.start()`'tan önce istenir; reddedilirse BT listelenmez (ekranda uyarı).

## Bilinen sınırlamalar

- **TURN**: Render UDP/TURN barındıramaz. Hücresel ağ / simetrik NAT'ta P2P kurulamayabilir; `EXPO_PUBLIC_TURN_*` ile bir TURN sağlayıcısı (coturn, Metered, Twilio vb.) ekleyin.
- **iOS Bluetooth**: iOS'ta BT HFP sistem tarafından otomatik seçilir; buton hoparlör ↔ ahize arasında geçer.
- **iOS App Store**: `UIBackgroundModes` yalnızca `audio` içerir. `voip` eklemek PushKit/CallKit olmadan inceleme reddine yol açar.
- **Arka plan (Android)**: Foreground service yoktur; uygulama uzun süre arka planda kalırsa sistem mikrofonu kesebilir.
- `react-native-incall-manager` New Architecture'da resmi olarak test edilmemiştir (interop katmanıyla çalışır); `expo-doctor` uyarısı `package.json` içinde bilinçli olarak hariç tutuldu.
