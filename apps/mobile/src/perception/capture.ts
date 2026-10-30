import type { CameraView } from 'expo-camera';
import { File } from 'expo-file-system';
import {
  ImageManipulator,
  SaveFormat,
  type ImageManipulatorContext,
  type ImageRef,
} from 'expo-image-manipulator';

import { abortError, createSerialGate } from '@/lib/async';
import { round } from '@/lib/stats';

/** CameraView's pictureSize preset. 16:9, so a 9:16 portrait preview shows the whole frame. */
export const PICTURE_SIZE = '1280x720';

export type CaptureOptions = {
  /** takePictureAsync quality (0..1). */
  captureQuality: number;
  /** The longer side is resized down to this many pixels. */
  longestSide: number;
  /** JPEG compression for the upload (0..1). */
  jpegCompress: number;
};

/** The M0 diagnostics settings (gate G5). */
export const DIAGNOSTICS_CAPTURE: CaptureOptions = {
  captureQuality: 0.8,
  longestSide: 768,
  jpegCompress: 0.6,
};

/**
 * The search loop sends 1008 px: measured from the Mac, sam-3.1 answered faster at 1008 px
 * (p50 357 ms / p95 712 ms) than at 768 px (p50 569 ms / p95 1332 ms).
 */
export const SESSION_CAPTURE: CaptureOptions = {
  captureQuality: 0.8,
  longestSide: 1008,
  jpegCompress: 0.6,
};

/**
 * Scene and question frames for Muse Spark (and SAM's checks on the same frame): 640 px. Spark's
 * time follows its input and reasoning; on the M4 measurement 640 px used 255 fewer input tokens
 * than 768 px and answered faster (median 2.3 s against 3.2 s on the same photos).
 */
export const SCENE_CAPTURE: CaptureOptions = {
  captureQuality: 0.8,
  longestSide: 640,
  jpegCompress: 0.6,
};

export type CapturedFrame = {
  /** JPEG bytes, base64, no data: prefix. */
  base64: string;
  width: number;
  height: number;
  captureMs: number;
  processMs: number;
  totalMs: number;
};

/**
 * Exactly one takePictureAsync is ever in flight, because a second call while one is pending
 * throws CameraNotReadyException on iOS. Module level and shared by every caller (diagnostics
 * and the search session), so it also holds back a new run, or a remounted screen, while a
 * cancelled or timed-out capture is still pending natively.
 */
const nativeCapture = createSerialGate();

/** True while an earlier capture is queued or still pending natively. */
export function isCaptureBusy(): boolean {
  return nativeCapture.busy;
}

/**
 * Capture -> resize (longest side) -> JPEG base64 -> release native refs -> delete the file.
 * May keep running after the caller gave up on it; it still releases everything it made.
 */
export async function captureFrame(
  camera: CameraView,
  signal: AbortSignal,
  options: CaptureOptions,
): Promise<CapturedFrame> {
  let t0 = 0;
  const picture = await nativeCapture.run(async () => {
    // Queued behind a hung capture and the caller is gone: do not touch the camera.
    if (signal.aborted) throw abortError();
    t0 = performance.now();
    // pictureRef keeps the photo in native memory: no file write and no base64 for the full frame.
    return camera.takePictureAsync({
      pictureRef: true,
      shutterSound: false,
      quality: options.captureQuality,
    });
  });
  if (!picture) throw new Error('Camera returned no picture (not ready yet?).');
  if (signal.aborted) {
    // Arrived after cancel, timeout or unmount: nobody wants it.
    picture.release();
    throw abortError();
  }
  const t1 = performance.now();

  let context: ImageManipulatorContext | null = null;
  let image: ImageRef | null = null;
  try {
    // manipulate() accepts the camera's PictureRef directly and fixes EXIF orientation.
    context = ImageManipulator.manipulate(picture);
    if (Math.max(picture.width, picture.height) > options.longestSide) {
      context.resize(
        picture.width >= picture.height
          ? { width: options.longestSide }
          : { height: options.longestSide },
      );
    }
    image = await context.renderAsync();
    const saved = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: options.jpegCompress,
      base64: true,
    });
    const t2 = performance.now();
    deleteCacheFile(saved.uri);
    if (!saved.base64) throw new Error('JPEG encoding returned no base64 data.');
    return {
      base64: saved.base64,
      width: saved.width,
      height: saved.height,
      captureMs: round(t1 - t0),
      processMs: round(t2 - t1),
      totalMs: round(t2 - t0),
    };
  } finally {
    image?.release();
    context?.release();
    picture.release();
  }
}

/** saveAsync always writes a JPEG to the cache directory; frames must never be kept. */
function deleteCacheFile(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (e) {
    console.warn('[capture] could not delete capture cache file', e);
  }
}
