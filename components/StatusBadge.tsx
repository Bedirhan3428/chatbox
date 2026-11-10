import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CallStatus } from '../hooks/useCall';
import { colors } from './theme';

const MAP: Record<CallStatus, { label: string; color: string }> = {
  idle: { label: 'Hazır', color: colors.textDim },
  connecting: { label: 'Bağlanıyor', color: colors.warning },
  waking: { label: 'Sunucu uyanıyor', color: colors.warning },
  'in-room': { label: 'Odada', color: colors.accent },
  transmitting: { label: 'Ses İletiliyor', color: colors.success },
  error: { label: 'Hata', color: colors.danger },
};

export const StatusBadge = memo(function StatusBadge({ status }: { status: CallStatus }) {
  const { label, color } = MAP[status];
  return (
    <View
      style={[styles.badge, { borderColor: color }]}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Durum: ${label}`}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: colors.surface,
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
});
