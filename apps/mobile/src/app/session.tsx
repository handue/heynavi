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
import { RadioGroup, type RadioOption } from '@/components/radio-group';
import { CONCEPT_IDS, conceptLabel, isConceptId, phrases } from '@/agent/phrases';
import { PICTURE_SIZE } from '@/perception/capture';
import { DetectionOverlay } from '@/session/detection-overlay';
import { LatencyHud } from '@/session/latency-hud';
import { MicStatus } from '@/session/mic-status';
import { StateStrip } from '@/session/state-strip';
import { useSearchSession } from '@/session/use-search-session';
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
 * Camera session: "Find a chair" (or the button, or Magic Tap) -> "Looking for a chair" ->
 * sam-3.1 every ~1 s -> 2-of-3 confirmation -> spoken position + haptic. "Stop", the button or
 * Magic Tap ends it; "Pause", "Resume" and "Repeat" work by voice. The VoiceOver escape gesture
 * stops it and goes back.
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
    concept,
    active,
    setConcept,
    stop,
    toggle: toggleSearch,
    voice,
  } = useSearchSession({ cameraAllowed: permission?.granted === true });
  const ui = phrases('en-US').ui;
  // A paused search (voice "pause") is still one the big button ends.
  const searching = active || snapshot.search.status === 'PAUSED';

  const preview = fitPreview(area.width, area.height);
  // A spoken target that is not one of the six ("find my keys") shows up as its own option.
  const conceptIds: string[] = isConceptId(concept) ? CONCEPT_IDS : [...CONCEPT_IDS, concept];
  const conceptOptions: RadioOption<string>[] = conceptIds.map((id) => ({
    value: id,
    label: capitalize(conceptLabel(id)),
    lang: 'en-US',
  }));

  function toggle(source: 'button' | 'magic-tap' = 'button') {
    if (searching || canSearch) toggleSearch(source);
  }

  function onAreaLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setArea({ width, height });
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.safeArea}>
      {/* collapsable={false}: Fabric flattens a layout-only View, and then the escape gesture and
          Magic Tap have no native view to reach. Magic Tap starts or ends the search. */}
      <View
        collapsable={false}
        style={styles.root}
        {...magicTapProps(() => toggle('magic-tap'))}
        onAccessibilityEscape={() => {
          stop();
          router.back();
        }}>
        <StateStrip
          target={capitalize(conceptLabel(concept))}
          status={snapshot.search.status}
          statusLabel={ui.status(snapshot.search.status)}
          window={snapshot.search.window}
          failing={snapshot.failing}
        />

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
                detections={snapshot.detections}
                label={conceptLabel(concept)}
                width={preview.width}
                height={preview.height}
              />
              <LatencyHud
                lastRttMs={snapshot.lastRttMs}
                p50RttMs={snapshot.p50RttMs}
                lastSamMs={snapshot.lastSamMs}
                frames={snapshot.frames}
              />
              {/* Tap anywhere on the preview to start or stop. VoiceOver users have the button, so
                  this duplicate target stays out of the accessibility tree. */}
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => toggle('button')}
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
          <MicStatus
            status={voice.micStatus}
            label={voice.micLabel}
            canAskAgain={voice.voiceState.canAskAgain}
            onPress={voice.pressMic}
          />
          <RadioGroup
            label={ui.conceptGroup}
            options={conceptOptions}
            value={concept}
            onChange={setConcept}
            scroll
          />
          <Button
            large
            label={searching ? ui.stopButton : ui.startButton(concept)}
            accessibilityHint={
              !searching
                ? ui.startHint(concept)
                : snapshot.search.status === 'PAUSED'
                  ? ui.pausedHint
                  : ui.stopHint
            }
            disabled={!searching && !canSearch}
            onPress={() => toggle('button')}
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
          Camera access is off. HeyNavi needs the camera to look for objects. Allow it in Settings,
          HeyNavi, Camera, then come back.
        </AppText>
        <Button label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} />
      </View>
    );
  }
  return (
    <View style={styles.permission}>
      <AppText>HeyNavi needs the camera to look for objects around you.</AppText>
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
