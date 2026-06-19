import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { colors, spacing, radius } from '../theme/theme';
import type { PendingIntent } from '../lib/api';

const GROUP_TYPES = ['cash', 'bank', 'wallet', 'card', 'prepaid'] as const;

function fieldLabel(key: string) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function Button({ label, onPress, tone = 'default' }: { label: string; onPress: () => void; tone?: 'default' | 'primary' | 'danger' }) {
  const bg = tone === 'primary' ? colors.primary : tone === 'danger' ? 'rgba(255,90,90,0.18)' : colors.surface;
  const fg = tone === 'primary' ? colors.background : tone === 'danger' ? '#ff6b6b' : colors.text;
  return (
    <Pressable
      onPress={onPress}
      style={{ backgroundColor: bg, borderRadius: radius.full, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 }}
    >
      <Text style={{ color: fg, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export function IntentCard({
  intent,
  busy,
  onAccept,
  onReject,
  onEdit,
}: {
  intent: PendingIntent;
  busy?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: (instruction: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const fields = Object.entries(intent).filter(([k]) => k !== 'intent');

  return (
    <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}>
      <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {fieldLabel(intent.intent)}
      </Text>
      {fields.map(([k, v]) => (
        <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>{fieldLabel(k)}</Text>
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{String(v)}</Text>
        </View>
      ))}

      {editing ? (
        <View style={{ marginTop: spacing.sm }}>
          <TextInput
            value={editText}
            onChangeText={setEditText}
            placeholder="What should change?"
            placeholderTextColor={colors.textMuted}
            keyboardAppearance="dark"
            style={{ backgroundColor: colors.surface, borderRadius: radius.sm, color: colors.text, padding: 10, marginBottom: 8 }}
          />
          <View style={{ flexDirection: 'row' }}>
            <Button
              label="Send"
              tone="primary"
              onPress={() => {
                if (!editText.trim()) return;
                onEdit(editText.trim());
                setEditing(false);
                setEditText('');
              }}
            />
            <Button label="Cancel" onPress={() => setEditing(false)} />
          </View>
        </View>
      ) : busy ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }} />
      ) : (
        <View style={{ flexDirection: 'row', marginTop: spacing.sm }}>
          <Button label="Accept" tone="primary" onPress={onAccept} />
          <Button label="Edit" onPress={() => setEditing(true)} />
          <Button label="Reject" tone="danger" onPress={onReject} />
        </View>
      )}
    </View>
  );
}

export function ClassifyAccountCard({
  accountName,
  onSubmit,
}: {
  accountName: string;
  onSubmit: (groupType: string, isLiability: boolean) => void;
}) {
  const [groupType, setGroupType] = useState<string | null>(null);
  const [isLiability, setIsLiability] = useState<boolean | null>(null);

  return (
    <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm }}>
      <Text style={{ color: colors.text, fontSize: 13, marginBottom: 8 }}>
        What kind of account is <Text style={{ fontWeight: '700' }}>{accountName}</Text>?
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
        {GROUP_TYPES.map((g) => (
          <Pressable
            key={g}
            onPress={() => setGroupType(g)}
            style={{
              backgroundColor: groupType === g ? colors.primary : colors.surface,
              borderRadius: radius.full,
              paddingHorizontal: 12,
              paddingVertical: 6,
              marginRight: 6,
              marginBottom: 6,
            }}
          >
            <Text style={{ color: groupType === g ? colors.background : colors.text, fontSize: 12, fontWeight: '600' }}>
              {fieldLabel(g)}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 6 }}>Does it count as debt?</Text>
      <View style={{ flexDirection: 'row', marginBottom: 8 }}>
        <Button label={isLiability === true ? '✓ Yes' : 'Yes'} onPress={() => setIsLiability(true)} />
        <Button label={isLiability === false ? '✓ No' : 'No'} onPress={() => setIsLiability(false)} />
      </View>
      <Button
        label="Confirm"
        tone="primary"
        onPress={() => groupType !== null && isLiability !== null && onSubmit(groupType, isLiability)}
      />
    </View>
  );
}
