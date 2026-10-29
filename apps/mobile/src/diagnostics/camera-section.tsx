import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { ChoiceGroup } from '@/components/choice-group';
import { Field } from '@/components/field';
import type { ReportPartsRef, ShutterAnswer } from '@/diagnostics/report';
import { CAPTURE, useCaptureTest, type FrameStat } from '@/diagnostics/use-capture-test';
import { formatMs, percentile } from '@/lib/stats';
import { colors, radii, spacing } from '@/theme/tokens';

type Props = { reportRef: ReportPartsRef };

export function CameraSection({ reportRef }: Props) {
  // Release builds auto-lock the screen; keep it awake while this screen (and camera) is open.
  useKeepAwake();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const test = useCaptureTest(cameraRef);
  const running = test.status === 'running';
  const overlayText = running
    ? `Frame ${test.frames.length + 1} of ${CAPTURE.frames}`
    : ready
      ? 'Camera ready'
      : 'Starting camera…';

  // A new run clears the previous run's report until it finishes.
  useEffect(() => {
    reportRef.current.camera = test.report ?? undefined;
  }, [reportRef, test.report]);

  return (
    <Card
      title="Camera capture (G5)"
      subtitle={`Back camera, ${CAPTURE.pictureSize}, 9:16 preview. Turn on Silent Mode (Action button or Control Center) and listen for a shutter click.`}>
      {permission?.granted ? (
        // Stable native parent: CameraView is its first child and never moves. Overlays are
        // absolutely positioned siblings rendered after it.
        <View collapsable={false} style={styles.preview}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            mode="picture"
            pictureSize={CAPTURE.pictureSize}
            animateShutter={false}
            onCameraReady={() => {
              setReady(true);
              test.onCameraReady();
            }}
            onMountError={(event) => setMountError(event.message)}
            accessibilityLabel="Camera preview"
          />
          <View style={styles.overlay}>
            <AppText variant="caption" tone="inverse">
              {overlayText}
            </AppText>
          </View>
        </View>
      ) : (
        <PermissionPrompt
          checking={permission == null}
          canAskAgain={permission?.canAskAgain ?? true}
          onRequest={requestPermission}
        />
      )}

      {mountError ? <AppText tone="danger">Camera failed to start: {mountError}</AppText> : null}

      <View style={styles.buttons}>
        <Button
          label={`Run capture test (${CAPTURE.frames} frames)`}
          accessibilityHint={`Takes ${CAPTURE.frames} photos about ${CAPTURE.targetIntervalMs / 1000} seconds apart and measures timings.`}
          disabled={!permission?.granted || !ready || running}
          onPress={test.run}
        />
        <Button
          label="Cancel capture test"
          variant="danger"
          disabled={!running}
          onPress={test.cancel}
        />
      </View>

      {test.error ? <AppText tone="danger">Error: {test.error}</AppText> : null}
      <CaptureSummary frames={test.frames} />
      <FrameList frames={test.frames} />

      {test.report && test.frames.length > 0 ? (
        <ShutterQuestion value={test.shutterAnswer} onChange={test.setShutterAnswer} />
      ) : null}
    </Card>
  );
}

function PermissionPrompt(props: {
  checking: boolean;
  canAskAgain: boolean;
  onRequest: () => void;
}) {
  if (props.checking) return <AppText tone="secondary">Checking camera permission…</AppText>;
  if (!props.canAskAgain) {
    return (
      <View style={styles.buttons}>
        <AppText tone="danger">
          Camera access is denied. Allow it in Settings, HeyNavi, Camera, then come back.
        </AppText>
        <Button label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} />
      </View>
    );
  }
  return (
    <View style={styles.buttons}>
      <AppText>HeyNavi needs the camera to run the capture test.</AppText>
      <Button
        label="Allow camera access"
        accessibilityHint="Shows the iOS camera permission prompt."
        onPress={props.onRequest}
      />
    </View>
  );
}

function CaptureSummary({ frames }: { frames: FrameStat[] }) {
  if (frames.length === 0) return null;
  const pick = (key: 'captureMs' | 'processMs' | 'totalMs') => frames.map((f) => f[key]);
  return (
    <View style={styles.summary}>
      <AppText variant="bodyStrong">Summary ({frames.length} frames)</AppText>
      <Field label="Capture p50 / p95" value={p50p95(pick('captureMs'))} />
      <Field label="Process p50 / p95" value={p50p95(pick('processMs'))} />
      <Field label="Total p50 / p95" value={p50p95(pick('totalMs'))} />
      <Field
        label="Output"
        value={`${frames[0].width}x${frames[0].height}, about ${frames[0].base64KB} KB base64`}
      />
    </View>
  );
}

function FrameList({ frames }: { frames: FrameStat[] }) {
  if (frames.length === 0) return null;
  return (
    <View style={styles.frames}>
      {frames.map((f) => (
        <AppText
          key={f.index}
          variant="mono"
          accessibilityLabel={`Frame ${f.index}: capture ${f.captureMs}, process ${f.processMs}, total ${f.totalMs} milliseconds, ${f.width} by ${f.height}, ${f.base64KB} kilobytes`}>
          #{String(f.index).padStart(2, '0')} cap {f.captureMs} · proc {f.processMs} · tot {f.totalMs} ms ·{' '}
          {f.width}x{f.height} · {f.base64KB} KB
        </AppText>
      ))}
    </View>
  );
}

function ShutterQuestion(props: { value: ShutterAnswer; onChange: (v: ShutterAnswer) => void }) {
  return (
    <View style={styles.summary}>
      <AppText variant="bodyStrong">Did you hear a shutter sound?</AppText>
      <ChoiceGroup
        label="Shutter sound heard"
        value={props.value}
        onChange={props.onChange}
        choices={[
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]}
      />
    </View>
  );
}

function p50p95(values: number[]): string {
  return `${formatMs(percentile(values, 50))} / ${formatMs(percentile(values, 95))}`;
}

const styles = StyleSheet.create({
  preview: {
    width: '62%',
    aspectRatio: 9 / 16,
    alignSelf: 'center',
    borderRadius: radii.chip,
    overflow: 'hidden',
    backgroundColor: colors.text,
  },
  overlay: {
    position: 'absolute',
    pointerEvents: 'none',
    left: spacing.sm,
    top: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.chip,
    backgroundColor: colors.scrim,
  },
  buttons: {
    gap: spacing.sm,
  },
  summary: {
    gap: spacing.xs,
  },
  frames: {
    gap: spacing.xs,
  },
});
