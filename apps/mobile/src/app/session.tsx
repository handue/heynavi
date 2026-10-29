import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { RadioGroup, type RadioOption } from '@/components/radio-group';
import { CONCEPT_IDS, conceptLabel, phrases, type ConceptId } from '@/agent/phrases';
import type { Lang } from '@/agent/types';
import { PICTURE_SIZE } from '@/perception/capture';
import { DetectionOverlay } from '@/session/detection-overlay';
import { LatencyHud } from '@/session/latency-hud';
import { StateStrip } from '@/session/state-strip';
import { useSearchSession } from '@/session/use-search-session';
import { colors, radii, spacing } from '@/theme/tokens';

const LANGUAGES: readonly RadioOption<Lang>[] = [
  { value: 'en-US', label: 'English', lang: 'en-US' },
  { value: 'ko-KR', label: '한국어', lang: 'ko-KR' },
];

/** Portrait 9:16, the same aspect as the 1280x720 capture, so nothing is cropped. */
const PREVIEW_ASPECT = 9 / 16;

/** The preview never gets less height than this, whatever the text size; the controls scroll. */
const MIN_PREVIEW_HEIGHT = 240;

/**
 * VS-1 camera session: tap -> "Looking for a chair" -> sam-3.1 every ~1 s -> 2-of-3
 * confirmation -> spoken position + haptic -> tap again stops. The VoiceOver escape gesture
 * stops it and goes back.
 */
export default function SessionScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [mountError, setMountError] = useState<string | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const {
    attachCamera,
    cameraReady,
    onCameraReady,
    snapshot,
    concept,
    lang,
    active,
    setConcept,
    setLang,
    stop,
    toggle: toggleSearch,
  } = useSearchSession();
  const ui = phrases(lang).ui;
  const canSearch = permission?.granted === true && cameraReady;

  const preview = fitPreview(area.width, area.height);
  const conceptOptions: RadioOption<ConceptId>[] = CONCEPT_IDS.map((id) => ({
    value: id,
    label: capitalize(conceptLabel(id, lang)),
    lang,
  }));

  function toggle() {
    if (active || canSearch) toggleSearch();
  }

  function onAreaLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setArea({ width, height });
  }

  return (
    <SafeAreaView edges={['bottom']} style={styles.safeArea}>
      {/* collapsable={false}: Fabric flattens a layout-only View, and then the escape gesture has
          no native view to reach. onMagicTap does not reach native on RN 0.88 yet (its C++ reads
          `onAccessibilityMagicTap`), so the UI promises nothing about Magic Tap. */}
      <View
        collapsable={false}
        style={styles.root}
        onMagicTap={toggle}
        onAccessibilityEscape={() => {
          stop();
          router.back();
        }}>
        <StateStrip
          target={capitalize(conceptLabel(concept, lang))}
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
                label={conceptLabel(concept, lang)}
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
                onPress={toggle}
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
          <RadioGroup
            label={ui.conceptGroup}
            options={conceptOptions}
            value={concept}
            onChange={setConcept}
            scroll
          />
          <RadioGroup label={ui.languageGroup} options={LANGUAGES} value={lang} onChange={setLang} />
          <Button
            large
            label={active ? ui.stopButton : ui.startButton(concept)}
            disabled={!active && !canSearch}
            onPress={toggle}
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
