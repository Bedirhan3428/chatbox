import { memo, ReactNode } from 'react';
import { Platform, Pressable, PressableProps, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { colors, MIN_TOUCH } from './theme';

export type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

type Props = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  icon?: IconName;
  caption?: string;
  active?: boolean;
  tone?: 'default' | 'danger' | 'accent';
  size?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

export const ControlButton = memo(function ControlButton({
  label,
  icon,
  caption,
  active = false,
  tone = 'default',
  size = 64,
  style,
  disabled,
  children,
  ...rest
}: Props) {
  const d = Math.max(size, MIN_TOUCH);
  const bg =
    tone === 'danger' ? colors.danger : tone === 'accent' || active ? colors.text : colors.surfaceHi;
  const fg = tone === 'danger' ? '#fff' : tone === 'accent' || active ? colors.bg : colors.text;

  return (
    <View style={[styles.wrap, style]}>
      {/* Ripple'ın daire içinde kalması için overflow: hidden olan sarmalayıcı */}
      <View style={[styles.clip, { width: d, height: d, borderRadius: d / 2 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={caption ? `${label}, ${caption}` : label}
          accessibilityState={{ selected: active, disabled: !!disabled }}
          android_ripple={{ color: colors.ripple, borderless: false }}
          hitSlop={8}
          pressRetentionOffset={24}
          disabled={disabled}
          style={({ pressed }) => [
            styles.btn,
            { backgroundColor: bg, opacity: disabled ? 0.4 : Platform.OS === 'ios' && pressed ? 0.7 : 1 },
          ]}
          {...rest}
        >
          {children ??
            (icon ? (
              <MaterialCommunityIcons name={icon} size={Math.round(d * 0.42)} color={fg} />
            ) : (
              <Text style={[styles.label, { color: fg }]}>{label}</Text>
            ))}
        </Pressable>
      </View>
      {caption ? (
        <Text style={styles.caption} numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 8, minWidth: MIN_TOUCH },
  clip: { overflow: 'hidden' },
  btn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  label: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  caption: { color: colors.textDim, fontSize: 12, maxWidth: 88 },
});
