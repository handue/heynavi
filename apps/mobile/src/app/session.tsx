import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState, useSyncExternalStore } from 'react';
import { Linking, Pressable, StyleSheet, View, type LayoutChangeEvent, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Button } from '@/components/button';
import { Orb } from '@/components/orb';
import { conceptLabel, phrases } from '@/agent/phrases';
import { PICTURE_SIZE } from '@/perception/capture';
import { scenePhrases } from '@/scene/scene-phrases';
import { AgentPanel } from '@/session/agent-panel';
import { CaptionCard } from '@/session/caption-card';
import { CENTER_SIZE, CONTROL_BAR_HEIGHT, ControlBar } from '@/session/control-bar';
import { DetectionOverlay } from '@/session/detection-overlay';
import { LatencyHud } from '@/session/latency-hud';
import { RouteCard } from '@/session/route-card';
import { TOP_BAR_HEIGHT, TopBar, type ChipTone, type PillTone } from '@/session/top-bar';
import { useCameraSession } from '@/session/use-camera-session';
import { getSettings, subscribeSettings } from '@/settings/app-settings';
import { colors, spacing } from '@/theme/tokens';

/** Portrait 9:16, the same aspect as the 1280x720 capture, so nothing is cropped from what is sent. */
const CAMERA_ASPECT = 9 / 16;

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
 * Camera session (ARCHITECTURE 3.3, wireframes 02–04): the live view fills the screen, with
 * HeyNavi's boxes, a top bar (close, voice status, settings), the line being spoken and round
 * floating controls with the living HeyNavi symbol in the middle. HeyNavi starts observing once the
 * camera is ready and mentions what could be in your way. Everything else is by voice: "What's
 * around me", "Where is the door", "Find a chair". Magic Tap and a tap on the view silence speech,
 * end a search, or pause and resume observing. The VoiceOver escape gesture ends a search and goes
 * back.
 */
export default function SessionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [mountError, setMountError] = useState<string | null>(null);
  const [screen, setScreen] = useState({ width: 0, height: 0 });
  const [captionHeight, setCaptionHeight] = useState(0);
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const {
    attachCamera,
    canSearch,
    onCameraReady,
    snapshot,
    sceneSnapshot,
    boxTurn,
    navSnapshot,
    endRoute,
    lastSaid,
    speaking,
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
  const mic = ui.mic;

  const camera = coverScreen(screen.width, screen.height);
  const listening = voice.micStatus === 'listening';
  const toolbarTop = screen.height - insets.bottom - spacing.md - CONTROL_BAR_HEIGHT;
  const bottomScrimHeight = insets.bottom + CONTROL_BAR_HEIGHT + 140;
  const captionTop = toolbarTop - spacing.sm - captionHeight;

  const thinking = sceneSnapshot.describing && !speaking;
  const pill: { label: string; spoken: string; tone: PillTone } = !listening
    ? {
        label: voice.micLabel,
        spoken: voice.micLabel,
        tone: voice.micStatus === 'needs-permission' || voice.micStatus === 'stopped' ? 'alert' : 'off',
      }
    : speaking && lastSaid?.kind === 'obstacle'
      ? { label: 'Caution ahead', spoken: 'Speaking, possible obstacle', tone: 'caution' }
      : speaking
        ? { label: 'HeyNavi is speaking…', spoken: 'Speaking', tone: 'speaking' }
        : thinking
          ? { label: 'HeyNavi is thinking…', spoken: 'Looking', tone: 'thinking' }
          : { label: 'HeyNavi is listening…', spoken: 'Listening', tone: 'listening' };
  const chip: { label: string; tone: ChipTone } = searching
    ? { label: `${sceneUi.searching}: ${conceptLabel(concept)} · ${ui.status(snapshot.search.status)}`, tone: 'searching' }
    : sceneSnapshot.running
      ? { label: sceneUi.observing, tone: 'observing' }
      : { label: sceneSnapshot.started ? sceneUi.paused : sceneUi.starting, tone: 'paused' };

  const boxes = searching
    ? snapshot.detections.map((detection, i) => ({ key: `search-${i}`, label: conceptLabel(concept), detection }))
    : sceneSnapshot.boxes;

  function close() {
    stop();
    router.back();
  }

  function onLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setScreen({ width, height });
  }

  return (
    // collapsable={false}: Fabric flattens a layout-only View, and then the escape gesture and
    // Magic Tap have no native view to reach.
    <View
      collapsable={false}
      style={styles.root}
      onLayout={onLayout}
      {...magicTapProps(() => tapAnywhere('magic-tap'))}
      onAccessibilityEscape={close}>
      <StatusBar style="light" />
      {permission?.granted ? (
        // Mounted once permission is granted and never moved: a stable native parent with
        // CameraView as its first child (expo issue #50015). It keeps the capture's 9:16 shape and
        // covers the screen, so on a tall phone a sliver of each side is off screen; what is sent
        // to the models is still the whole frame. Overlays are siblings drawn after it.
        <View collapsable={false} style={[styles.camera, camera]}>
          <CameraView
            ref={attachCamera}
            style={StyleSheet.absoluteFill}
            facing="back"
            mode="picture"
            pictureSize={PICTURE_SIZE}
            animateShutter={false}
            onCameraReady={onCameraReady}
            onMountError={(event) => setMountError(event.message)}
            accessibilityLabel="Camera view"
          />
          {/* Soft gradients behind the top bar and the controls, in the camera view's coordinates
              (it can extend past the screen). Contrast for the white captions on bright scenes. */}
          <View pointerEvents="none" style={[styles.topScrim, { top: -camera.top, height: insets.top + TOP_BAR_HEIGHT + spacing.xl }]} />
          <View
            pointerEvents="none"
            style={[styles.bottomScrim, { top: screen.height - camera.top - bottomScrimHeight, height: bottomScrimHeight }]}
          />
          <DetectionOverlay
            boxes={boxes}
            width={camera.width}
            height={camera.height}
            safeTop={insets.top + TOP_BAR_HEIGHT + spacing.sm - camera.top}
            safeBottom={captionTop - spacing.sm - camera.top}
            visibleLeft={-camera.left}
            visibleRight={-camera.left + screen.width}
            showConfidence={settings.devOverlay}
            turn={searching ? undefined : boxTurn}
          />
        </View>
      ) : (
        <PermissionPrompt
          checking={permission == null}
          canAskAgain={permission?.canAskAgain ?? true}
          onRequest={requestPermission}
        />
      )}

      {/* Tap anywhere on the view: same as Magic Tap. VoiceOver users have the buttons and Magic
          Tap, so this duplicate target stays out of the accessibility tree. */}
      {permission?.granted ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => tapAnywhere('button')}
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}

      {/* The decision panel while observing; SAM timings during a search. */}
      {settings.devOverlay && permission?.granted && !searching ? (
        <AgentPanel
          look={sceneSnapshot.lastLook}
          remembered={sceneSnapshot.items.length}
          told={sceneSnapshot.items.filter((i) => i.lastSpokenAt != null).length}
          style={[styles.panel, { top: insets.top + TOP_BAR_HEIGHT + spacing.sm }]}
        />
      ) : null}
      {settings.devOverlay && permission?.granted && searching ? (
        <LatencyHud
          model="SAM"
          lastRttMs={snapshot.lastRttMs}
          p50RttMs={snapshot.p50RttMs}
          lastModelMs={snapshot.lastSamMs}
          frames={snapshot.frames}
          style={[styles.hud, { top: insets.top + TOP_BAR_HEIGHT + spacing.md }]}
        />
      ) : null}

      <TopBar onClose={close} onSettings={() => router.push('/settings')} pill={pill} chip={chip} />

      {permission?.granted ? (
        <View style={[styles.bottom, { bottom: insets.bottom + spacing.md }]} pointerEvents="box-none">
          {mountError ? (
            <AppText tone="inverse" style={styles.error}>
              Camera failed to start: {mountError}
            </AppText>
          ) : null}
          {/* The route card (while navigating) and the caption, measured together so box labels
              stay above both. Taps on the caption go through to the camera view. */}
          <View pointerEvents="box-none" style={styles.cards} onLayout={(e) => setCaptionHeight(e.nativeEvent.layout.height)}>
            <RouteCard nav={navSnapshot} onClose={endRoute} />
            <View pointerEvents="none">
              <CaptionCard caption={lastSaid} speaking={speaking} />
            </View>
          </View>
          <ControlBar
            left={
              searching
                ? {
                    icon: 'xmark',
                    caption: 'End search',
                    label: ui.stopButton,
                    hint: snapshot.search.status === 'PAUSED' ? ui.pausedHint : ui.stopHint,
                    onPress: pressPrimary,
                  }
                : updatesHeld
                  ? { icon: 'play.fill', caption: 'Resume', label: sceneUi.resumeButton, hint: sceneUi.resumeHint, disabled: !canSearch, onPress: pressPrimary }
                  : { icon: 'pause.fill', caption: 'Pause', label: sceneUi.pauseButton, hint: sceneUi.pauseHint, disabled: !canSearch, onPress: pressPrimary }
            }
            center={{
              caption: 'Describe',
              label: sceneUi.describeButton,
              hint: sceneUi.describeHint,
              disabled: !canSearch,
              onPress: describe,
              content: <Orb size={CENTER_SIZE} mode={speaking ? 'speaking' : thinking ? 'thinking' : listening ? 'listening' : 'idle'} />,
            }}
            right={{
              icon: listening ? 'mic.fill' : 'mic.slash.fill',
              caption: listening ? 'Mic on' : 'Mic off',
              label: listening ? mic.turnOff : voice.micStatus === 'needs-permission' ? mic.allow : mic.turnOn,
              hint:
                voice.micStatus === 'needs-permission'
                  ? voice.voiceState.canAskAgain
                    ? mic.allowHint
                    : mic.openSettingsHint
                  : listening
                    ? mic.turnOffHint
                    : mic.turnOnHint,
              disabled: voice.micStatus === 'unavailable',
              onPress: voice.pressMic,
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function PermissionPrompt(props: { checking: boolean; canAskAgain: boolean; onRequest: () => void }) {
  if (props.checking) {
    return (
      <View style={styles.permission}>
        <AppText tone="inverse">Checking camera permission…</AppText>
      </View>
    );
  }
  if (!props.canAskAgain) {
    return (
      <View style={styles.permission}>
        <AppText tone="inverse">
          Camera access is off. The camera is needed to describe your surroundings. Allow it in Settings, HeyNavi,
          Camera, then come back.
        </AppText>
        <Button label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} />
      </View>
    );
  }
  return (
    <View style={styles.permission}>
      <AppText tone="inverse">The camera is needed to describe your surroundings.</AppText>
      <Button label="Allow camera access" accessibilityHint="Shows the iOS camera permission prompt." onPress={props.onRequest} />
    </View>
  );
}

/**
 * The 9:16 camera view that covers the whole screen: as tall as the screen on a tall phone (its
 * sides then extend past the screen), as wide as the screen otherwise. Centered.
 */
function coverScreen(width: number, height: number): { width: number; height: number; left: number; top: number } {
  if (width === 0 || height === 0) return { width: 0, height: 0, left: 0, top: 0 };
  const tall = height / width > 1 / CAMERA_ASPECT;
  const w = tall ? height * CAMERA_ASPECT : width;
  const h = tall ? height : width / CAMERA_ASPECT;
  return { width: Math.ceil(w), height: Math.ceil(h), left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2) };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cameraChrome, overflow: 'hidden' },
  camera: { position: 'absolute', backgroundColor: colors.cameraChrome },
  hud: { left: spacing.md, bottom: undefined },
  panel: { left: spacing.md, right: spacing.md },
  topScrim: { position: 'absolute', left: 0, right: 0, backgroundImage: 'linear-gradient(180deg, rgba(0, 0, 0, 0.4) 0%, rgba(0, 0, 0, 0) 100%)' },
  bottomScrim: { position: 'absolute', left: 0, right: 0, backgroundImage: 'linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.55) 100%)' },
  bottom: { position: 'absolute', left: spacing.md, right: spacing.md, gap: spacing.md },
  cards: { gap: spacing.sm },
  error: { padding: spacing.sm },
  permission: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
});
