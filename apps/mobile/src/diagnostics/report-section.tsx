import { useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { buildReport, type ReportPartsRef } from '@/diagnostics/report';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = { reportRef: ReportPartsRef };

export function ReportSection({ reportRef }: Props) {
  const [json, setJson] = useState<string | null>(null);

  function showReport() {
    const text = JSON.stringify(buildReport(reportRef.current), null, 2);
    console.log(`[HeyNavi diagnostics report]\n${text}`);
    setJson(text);
    AccessibilityInfo.announceForAccessibility('Report ready below. It is also in the Metro log.');
  }

  return (
    <Card
      title="Report"
      subtitle="JSON summary of every test above. Also printed to the Metro terminal.">
      <Button
        label={json ? 'Refresh report' : 'Show report'}
        accessibilityHint="Builds a JSON summary of all results so far."
        onPress={showReport}
      />
      {json ? (
        <View style={styles.box}>
          <AppText variant="mono" selectable>
            {json}
          </AppText>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.background,
    borderRadius: radii.chip,
    padding: spacing.md,
  },
});
