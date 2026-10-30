// Videos and recordings are probed in the page before they are imported: Rust
// stores them unchanged and decodes nothing, so whatever WebView2 can read the
// metadata of is what LineHush takes (and can play). The functions below use
// browser APIs (media elements, canvas); only `isMediaFile` runs under Node.
import type { MediaMeta } from "./native.ts";

/** Extensions of the formats WebView2 plays, for files that come without a MIME type. */
export const MEDIA_EXTENSIONS = [
  "mp4",
  "m4v",
  "webm",
  "mp3",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
];
/** The `accept` list of a file input for media. */
export const MEDIA_ACCEPT = [
  "video/*",
  "audio/*",
  ...MEDIA_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");

/** A video or audio file by its MIME type or, without one that says so, its extension. */
export function isMediaFile(file: { name: string; type: string }): boolean {
  if (/^(video|audio)\//.test(file.type)) return true;
  if (file.type.startsWith("image/")) return false;
  const ext = /\.([^.\\/]+)$/.exec(file.name)?.[1]?.toLowerCase();
  return !!ext && MEDIA_EXTENSIONS.includes(ext);
}

/** Why a file is turned away: the media element could not read it. */
export const UNSUPPORTED = "不支持的媒体格式";
/** How long reading the metadata, or seeking to the cover frame, may take. */
const TIMEOUT_MS = 10_000;
/** The largest cover frame, in CSS pixels, as the tile shows it (twice the 280×200 tile). */
const POSTER_WIDTH = 560;
const POSTER_HEIGHT = 400;

export interface MediaProbe extends MediaMeta {
  /** A video's cover frame as PNG; null for audio. */
  poster: Blob | null;
}

/**
 * Resolves once `media` fires `event` (after `start`), rejects with
 * `UNSUPPORTED` on an error or after the timeout.
 */
function once(media: HTMLMediaElement, event: string, start: () => void) {
  return new Promise<void>((resolve, reject) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      media.removeEventListener(event, onEvent);
      media.removeEventListener("error", onError);
      if (ok) resolve();
      else reject(new Error(UNSUPPORTED));
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), TIMEOUT_MS);
    media.addEventListener(event, onEvent);
    media.addEventListener("error", onError);
    start();
  });
}

/**
 * Reads a video or recording the way the editor will play it: its duration
 * and, for a video, its frame size and a cover frame (`min(0.5 s, a tenth of
 * it)` in, scaled into 560×400). A file with a picture but no video track (an
 * M4A, say, or a WebM with sound only) is audio. Fails with `UNSUPPORTED`
 * when the media element cannot read it.
 */
export async function probeMedia(file: Blob): Promise<MediaProbe> {
  const url = URL.createObjectURL(file);
  // A <video> reads audio files too (no frame size then).
  const media = document.createElement("video");
  media.muted = true;
  media.preload = "metadata";
  try {
    await once(media, "loadedmetadata", () => {
      media.src = url;
    });
    let duration = media.duration;
    // Some recordings (MediaRecorder's WebM) carry no duration: seeking far
    // past the end makes the element find it.
    if (duration === Infinity) {
      await once(media, "durationchange", () => {
        media.currentTime = Number.MAX_SAFE_INTEGER;
      }).catch(() => {});
      duration = media.duration;
    }
    if (!Number.isFinite(duration) || duration < 0) throw new Error(UNSUPPORTED);
    const width = media.videoWidth;
    const height = media.videoHeight;
    if (!width || !height)
      return { kind: "audio", width: 0, height: 0, duration, poster: null };
    const at = Math.min(0.5, duration / 10);
    await once(media, "seeked", () => {
      media.currentTime = at;
    });
    const scale = Math.min(1, POSTER_WIDTH / width, POSTER_HEIGHT / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d")!.drawImage(media, 0, 0, canvas.width, canvas.height);
    const poster = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!poster) throw new Error(UNSUPPORTED);
    return { kind: "video", width, height, duration, poster };
  } finally {
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(url);
  }
}
