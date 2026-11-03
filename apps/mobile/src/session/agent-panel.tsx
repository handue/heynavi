import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/app-text';
import { Icon } from '@/components/icon';
import type { LastLook } from '@/scene/scene-controller';
import { decision, footer, panelItems, panelLabel, samTally, seconds, sparkMeta, type PanelItem } from '@/session/agent-panel-model';
import { colors, iconSize, radii, spacing } from '@/theme/tokens';

type Props = {
  look: LastLook | null;
  /** Things in scene memory, and how many of them HeyNavi has told the user about. */
  remembered: number;
  told: number;
  style?: StyleProp<ViewStyle>;
};

/** Light blue that reads on dark glass (the boxes' Meta blue is too dark there for small text). */
const FOUND = '#7FB2FF';
const MUTED = 'rgba(255, 255, 255, 0.62)';

/**
 * The decision panel (Settings › Advanced): the agent loop of the latest look, live over the
 * camera, for demos and tuning. Muse Spark proposes what matters to walking, SAM 3.1 checks it on
 * the same frame, and HeyNavi's own rules decide whether to say anything. Taps go through to the
 * camera view.
 */
export function AgentPanel({ look, remembered, told, style }: Props) {
  return (
    <View style={[styles.panel, style]} pointerEvents="none" accessible accessibilityLabel={panelLabel(look, remembered, told)}>
      {look ? <Steps look={look} remembered={remembered} told={told} /> : <AppText style={styles.muted}>Waiting for the first look…</AppText>}
    </View>
  );
}

function Steps({ look, remembered, told }: { look: LastLook; remembered: number; told: number }) {
  const items = panelItems(look);
  const outcome = decision(look);
  return (
    <>
      <Step n={1} title="Muse Spark sees" meta={sparkMeta(look)}>
        {items.length > 0 ? items.map((item, i) => <ItemRow key={`${item.label}-${i}`} item={item} />) : <AppText style={styles.muted}>Nothing to list</AppText>}
      </Step>
      <Step n={2} title="SAM 3.1 checks" meta={`${seconds(look.samMs)} · ${samTally(look)}`} />
      <Step n={3} title="HeyNavi decides" meta={outcome.spoke ? 'speaks' : 'stays quiet'}>
        <AppText numberOfLines={3} maxFontSizeMultiplier={1.3} style={outcome.spoke ? styles.said : styles.muted}>
          {outcome.spoke ? `“${outcome.text}”` : outcome.text}
        </AppText>
      </Step>
      <AppText numberOfLines={1} maxFontSizeMultiplier={1.2} style={styles.footer}>
        {footer(look, remembered, told)}
      </AppText>
    </>
  );
}

function Step({ n, title, meta, children }: { n: number; title: string; meta: string; children?: ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepHead}>
        <View style={styles.number}>
          <AppText maxFontSizeMultiplier={1.2} style={styles.numberText}>
            {n}
          </AppText>
        </View>
        <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.title}>
          {title}
        </AppText>
        <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.meta}>
          {meta}
        </AppText>
      </View>
      {children ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

function ItemRow({ item }: { item: PanelItem }) {
  const icon = item.sam === 'found' ? 'checkmark.circle.fill' : item.sam === 'missed' ? 'xmark.circle' : 'circle.dashed';
  return (
    <View style={[styles.row, !item.considered && styles.ignored]}>
      <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.label}>
        {item.label}
      </AppText>
      <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.detail}>
        {item.considered ? item.detail : `${item.detail} · skipped`}
      </AppText>
      <Icon name={icon} size={iconSize.sm - 2} color={item.sam === 'found' ? FOUND : MUTED} />
      <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.sam, item.sam === 'found' && styles.found]}>
        {item.samText}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.card - 4,
    backgroundColor: 'rgba(16, 18, 22, 0.72)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  step: { gap: 4 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  number: {
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberText: { color: colors.white, fontSize: 11, lineHeight: 14, fontWeight: '700' },
  title: { color: colors.white, fontSize: 14, lineHeight: 18, fontWeight: '600' },
  meta: { flex: 1, textAlign: 'right', color: MUTED, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  body: { paddingLeft: 26, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ignored: { opacity: 0.5 },
  label: { flexShrink: 1, color: colors.white, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  detail: { flex: 1, color: MUTED, fontSize: 12, lineHeight: 18 },
  sam: { color: MUTED, fontSize: 12, lineHeight: 18, fontVariant: ['tabular-nums'] },
  found: { color: FOUND, fontWeight: '600' },
  said: { color: colors.white, fontSize: 13, lineHeight: 18 },
  muted: { color: MUTED, fontSize: 13, lineHeight: 18 },
  footer: { color: MUTED, fontSize: 11, lineHeight: 15, fontVariant: ['tabular-nums'] },
});
