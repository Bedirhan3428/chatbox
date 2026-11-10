type IceServer = { urls: string | string[]; username?: string; credential?: string };

// EXPO_PUBLIC_* değişkenleri build anında satır içine gömülür (dinamik erişim yapmayın).
const SIGNALING_URL: string = process.env.EXPO_PUBLIC_SIGNALING_URL || 'ws://10.0.2.2:8080';

const TURN_URL: string | undefined = process.env.EXPO_PUBLIC_TURN_URL;
const TURN_USERNAME: string | undefined = process.env.EXPO_PUBLIC_TURN_USERNAME;
const TURN_CREDENTIAL: string | undefined = process.env.EXPO_PUBLIC_TURN_CREDENTIAL;

const iceServers: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

if (TURN_URL) {
  iceServers.push({
    urls: TURN_URL.split(',').map((u) => u.trim()),
    username: TURN_USERNAME,
    credential: TURN_CREDENTIAL,
  });
}

export const env = {
  signalingUrl: SIGNALING_URL,
  rtcConfig: {
    iceServers,
    bundlePolicy: 'max-bundle' as const,
    rtcpMuxPolicy: 'require' as const,
    iceCandidatePoolSize: 2,
  },
  maxRoomSize: 4,
  heartbeatIntervalMs: 25_000,
  heartbeatTimeoutMs: 10_000,
  statsIntervalMs: 1_000,
  speakingThreshold: 0.02,
};
