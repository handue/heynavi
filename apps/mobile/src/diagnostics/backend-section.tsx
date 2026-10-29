import { useEffect } from 'react';
import { AccessibilityInfo, View, StyleSheet } from 'react-native';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Field } from '@/components/field';
import type { ReportPartsRef } from '@/diagnostics/report';
import { UNREACHABLE_HELP, useBackendPing } from '@/diagnostics/use-backend-ping';
import { formatMs } from '@/lib/stats';
import { spacing } from '@/theme/tokens';

type Props = { reportRef: ReportPartsRef };

export function BackendSection({ reportRef }: Props) {
  const backend = useBackendPing();
  const result = backend.result;

  useEffect(() => {
    if (!result) return;
    reportRef.current.backend = result;
    AccessibilityInfo.announceForAccessibility(
      result.ok ? `Backend reachable in ${result.latencyMs} milliseconds.` : 'Backend ping failed.',
    );
  }, [reportRef, result]);

  return (
    <Card title="Backend over LAN" subtitle={`GET ${backend.url}, 4 second timeout.`}>
      <Button
        label={backend.pending ? 'Pinging…' : 'Ping backend'}
        accessibilityHint="Calls the backend health endpoint and measures the round trip."
        disabled={backend.pending}
        onPress={backend.ping}
      />
      {result ? (
        <View style={styles.fields}>
          <Field
            label="Result"
            value={result.ok ? 'reachable' : 'failed'}
            tone={result.ok ? 'success' : 'danger'}
          />
          <Field label="HTTP status" value={result.status == null ? '–' : String(result.status)} />
          <Field label="Latency" value={formatMs(result.latencyMs)} />
          <Field
            label="key_configured"
            value={result.keyConfigured == null ? 'unknown' : String(result.keyConfigured)}
            tone={result.keyConfigured === false ? 'danger' : 'default'}
          />
          {result.error ? <Field label="Error" value={result.error} tone="danger" /> : null}
          {!result.ok ? <AppText tone="secondary">{UNREACHABLE_HELP}</AppText> : null}
          {result.keyConfigured === false ? (
            <AppText tone="secondary">
              The backend is up but has no Meta API key. Set MODEL_API_KEY in backend/.env on the
              Mac and restart the server.
            </AppText>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  fields: {
    gap: spacing.xs,
  },
});
