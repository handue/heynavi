import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { conceptLabel, phrases } from '@/agent/phrases';
import { PICTURE_SIZE } from '@/perception/capture';
import { DetectionOverlay } from '@/session/detection-overlay';
import { LatencyHud } from '@/session/latency-hud';
import { MicStatus } from '@/session/mic-status';
import { SessionStatus } from '@/session/session-status';
import { StateStrip } from '@/session/state-strip';
import { useCameraSession } from '@/session/use-camera-session';
import { scenePhrases } from '@/scene/scene-phrases';
import { colors, radii, spacing } from '@/theme/tokens';

/** Portrait 9:16, the same aspect as the 1280x720 capture, so nothing is cropped. */
const PREVIEW_ASPECT = 9 / 16;

/** The preview never gets less height than this, whatever the text size; the controls scroll. */
const MIN_PREVIEW_HEIGHT = 240;

/**
 * `onAccessibilityMagicTap` is missing from ViewProps. Fabric's native view only handles the
 * VoiceOver Magic Tap (two-finger double tap) when this prop is set, and the JS view config
 * only forwards it with patches/react-native+0.88.1.patch. The renderer
 * (ReactNativeAttributePayload) sends any function-valued prop listed in validAttributes to
 * native as `true`, which AccessibilityProps reads as a bool. Native then dispatches "magicTap"
 * (topMagicTap), which React delivers to `onMagicTap`: that is the handler that runs.
 */
type MagicTapProps = Pick<ViewProps, 'onMagicTap'> & { onAccessibilityMagicTap?: () => void };

function magicTapProps(handler: () => void): ViewProps {
  const props: MagicTapProps = { onMagicTap: handler, onAccessibilityMagicTap: handler };
  return props as ViewProps;
}

/**
 * Camera session (ARCHITECTURE 3.3), camera first: the preview, what HeyNavi is doing and what it
 * last said, the mic status, and two controls. HeyNavi starts observing once the camera is ready
 * and mentions what it notices. Everything else is by voice: "What's around me", "Find a chair",
 * "Where is the entrance" (no object picker). Magic Tap and a tap on the preview silence speech,
 * end a search, or pause and resume observing. The VoiceOver escape gesture ends a search and
 * goes back.
 */
export default function SessionScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [mountError, setMountError] = useState<string | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const {
    attachCamera,
    canSearch,
    onCameraReady,
    snapshot,
    sceneSnapshot,
    lastSaid,
    concept,
    searching,
    updatesHeld,
    pressPrimary,
    tapAnywhere,
    describe,
    stop,
    voice,
  } = useCameraSession({ cameraAllowed: permission?.granted === true });
  const ui = phrases('en-US').ui;
  const sceneUi = scenePhrases.ui;
  const sessionState = sceneSnapshot.running ? 'observing' : sceneSnapshot.started ? 'paused' : 'starting';

  const preview = fitPreview(area.width, area.height);

  function onAreaLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setArea({ width, height });
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.safeArea}>
      {/* collapsable={false}: Fabric flattens a layout-only View, and then the escape gesture and
          Magic Tap have no native view to reach. Magic Tap silences speech, ends a search, or
          holds and restarts the scene updates. */}
      <View
        collapsable={false}
        style={styles.root}
        {...magicTapProps(() => tapAnywhere('magic-tap'))}
        onAccessibilityEscape={() => {
          stop();
          router.back();
        }}>
        <View style={styles.previewArea} onLayout={onAreaLayout}>
          {permission?.granted ? (
            // Mounted once permission is granted, whatever the layout, and never moved: a stable
            // native parent with CameraView as its first child (expo issue #50015). Overlays are
            // absolutely positioned siblings rendered after it.
            <View collapsable={false} style={[styles.preview, preview]}>
              <CameraView
                ref={attachCamera}
                style={StyleSheet.absoluteFill}
                facing="back"
                mode="picture"
                pictureSize={PICTURE_SIZE}
                animateShutter={false}
                onCameraReady={onCameraReady}
                onMountError={(event) => setMountError(event.message)}
                accessibilityLabel="Camera preview"
              />
              <DetectionOverlay
                boxes={
                  searching
                    ? snapshot.detections.map((detection, i) => ({ key: `search-${i}`, label: conceptLabel(concept), detection }))
                    : sceneSnapshot.boxes
                }
                width={preview.width}
                height={preview.height}
              />
              {searching ? (
                <LatencyHud
                  model="SAM"
                  lastRttMs={snapshot.lastRttMs}
                  p50RttMs={snapshot.p50RttMs}
                  lastModelMs={snapshot.lastSamMs}
                  frames={snapshot.frames}
                />
              ) : (
                <LatencyHud
                  model="Spark"
                  lastRttMs={sceneSnapshot.lastRttMs}
                  p50RttMs={sceneSnapshot.p50RttMs}
                  lastModelMs={sceneSnapshot.lastSparkMs}
                  frames={sceneSnapshot.calls}
                  note={sceneSnapshot.hold?.frame === 'forward' ? 'held forward' : 'camera view'}
                />
              )}
              {/* Tap anywhere on the preview: same as Magic Tap. VoiceOver users have the buttons
                  and Magic Tap, so this duplicate target stays out of the accessibility tree. */}
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => tapAnywhere('button')}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </View>
          ) : (
            <PermissionPrompt
              checking={permission == null}
              canAskAgain={permission?.canAskAgain ?? true}
              onRequest={requestPermission}
            />
          )}
        </View>

        {/* At large text sizes the controls scroll instead of squeezing the preview. */}
        <ScrollView style={styles.controlsScroll} contentContainerStyle={styles.controls}>
          {mountError ? <AppText tone="danger">Camera failed to start: {mountError}</AppText> : null}
          {searching ? (
            <StateStrip
              target={capitalize(conceptLabel(concept))}
              status={snapshot.search.status}
              statusLabel={ui.status(snapshot.search.status)}
              window={snapshot.search.window}
              failing={snapshot.failing}
            />
          ) : null}
          <SessionStatus state={searching ? null : sessionState} verbosity={sceneSnapshot.verbosity} lastSaid={lastSaid} />
          <MicStatus
            status={voice.micStatus}
            label={voice.micLabel}
            canAskAgain={voice.voiceState.canAskAgain}
            onPress={voice.pressMic}
          />
          <Button
            large
            label={searching ? ui.stopButton : updatesHeld ? sceneUi.resumeButton : sceneUi.pauseButton}
            accessibilityHint={
              searching
                ? snapshot.search.status === 'PAUSED'
                  ? ui.pausedHint
                  : ui.stopHint
                : updatesHeld
                  ? sceneUi.resumeHint
                  : sceneUi.pauseHint
            }
            disabled={!searching && !canSearch}
            onPress={pressPrimary}
          />
          <Button
            variant="secondary"
            label={sceneUi.describeButton}
            accessibilityHint={sceneUi.describeHint}
            disabled={!canSearch}
            onPress={describe}
          />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function PermissionPrompt(props: { checking: boolean; canAskAgain: boolean; onRequest: () => void }) {
  if (props.checking) {
    return <AppText tone="secondary">Checking camera permission…</AppText>;
  }
  if (!props.canAskAgain) {
    return (
      <View style={styles.permission}>
        <AppText tone="danger">
          Camera access is off. The camera is needed to describe your surroundings. Allow it in Settings,
          HeyNavi, Camera, then come back.
        </AppText>
        <Button label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} />
      </View>
    );
  }
  return (
    <View style={styles.permission}>
      <AppText>The camera is needed to describe your surroundings.</AppText>
      <Button
        label="Allow camera access"
        accessibilityHint="Shows the iOS camera permission prompt."
        onPress={props.onRequest}
      />
    </View>
  );
}

/** Largest 9:16 rectangle that fits the available area. */
function fitPreview(width: number, height: number): { width: number; height: number } {
  const fitted = Math.min(width, height * PREVIEW_ASPECT);
  return { width: Math.floor(fitted), height: Math.floor(fitted / PREVIEW_ASPECT) };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.white,
  },
  root: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  previewArea: {
    flex: 1,
    minHeight: MIN_PREVIEW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  preview: {
    borderRadius: radii.card,
    overflow: 'hidden',
    backgroundColor: colors.text,
  },
  permission: {
    alignSelf: 'stretch',
    gap: spacing.sm,
  },
  controlsScroll: {
    // Content height while it fits; shrinks (and scrolls) once it does not.
    flexGrow: 0,
  },
  controls: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
});
