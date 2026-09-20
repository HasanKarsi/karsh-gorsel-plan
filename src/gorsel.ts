/**
 * The image compressor's arithmetic: what a file is, how big it will be, what
 * it will be called and whether the machine can afford to start it now.
 *
 * Plain TypeScript on purpose — no DOM, no React, no codec. Everything here is
 * a function of bytes and numbers, so it runs the same in the page, in the
 * worker and under Node, where it is tested against real file headers.
 */

/* ---- Formats --------------------------------------------------------- */

/** What the first bytes of a file say it is — not what its name or MIME type claims. */
export type SourceFormat =
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "avif"
  | "bmp"
  | "heic"
  | "tiff"
  | "svg"
  | "unknown";

/** What the tool can write. */
export type EncodedFormat = "webp" | "avif" | "jpeg" | "png";

/** The visitor's choice; "same" keeps each file in its own format where that makes sense. */
export type OutputChoice = "same" | EncodedFormat;

export const OUTPUT_CHOICES: readonly OutputChoice[] = ["same", "webp", "avif", "jpeg", "png"];

export const MIME: Record<EncodedFormat, string> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};

export const EXTENSION: Record<EncodedFormat, string> = {
  webp: "webp",
  avif: "avif",
  jpeg: "jpg",
  png: "png",
};

/**
 * "Same as the input" for inputs that have no encoder of their own. GIF and
 * BMP become PNG — the lossless choice, so a logo or a screenshot is not
 * smeared into JPEG blocks. HEIC (which only Safari decodes) is a camera photo,
 * so JPEG. Anything else a browser happened to open becomes PNG and loses
 * nothing on the way.
 */
export function resolveOutputFormat(source: SourceFormat, choice: OutputChoice): EncodedFormat {
  if (choice !== "same") return choice;
  switch (source) {
    case "jpeg":
    case "heic":
      return "jpeg";
    case "webp":
    case "avif":
    case "png":
      return source;
    default:
      return "png";
  }
}

/* ---- Settings -------------------------------------------------------- */

/**
 * Starting qualities, one per lossy format, because the scales are not the
 * same scale: AVIF at 55 looks like JPEG at 80, WebP at 75 sits between.
 */
export const DEFAULT_QUALITY: Record<Exclude<EncodedFormat, "png">, number> = {
  webp: 75,
  avif: 55,
  jpeg: 78,
};

/**
 * OxiPNG effort. PNG is lossless, so the only dial is how hard to search for a
 * smaller packing; past 4 the gain is a few bytes for many more seconds.
 */
export const PNG_LEVELS = { fast: 1, balanced: 2, thorough: 4 } as const;
export type PngEffort = keyof typeof PNG_LEVELS;

/** Longest-side presets in pixels; 0 keeps the original size. */
export const MAX_SIDE_PRESETS = [0, 3840, 2560, 1920, 1280, 800] as const;

export const LIMITS = {
  /** Files per batch. */
  files: 60,
  /** Pixels per image, in megapixels. A 50 MP RGBA frame is 200 MB before the encoder copies it. */
  megapixels: 50,
} as const;

/**
 * The largest side each encoder accepts. WebP stores dimensions in 14 bits;
 * MozJPEG stops at 65500 although the format would take 65535; the rest are
 * bounded by memory long before their format limit.
 */
export const ENCODER_MAX_SIDE: Record<EncodedFormat, number> = {
  webp: 16383,
  avif: 65536,
  jpeg: 65500,
  png: 65535,
};

export interface JobSettings {
  format: EncodedFormat;
  /** 0–100; ignored for PNG. */
  quality: number;
  /** OxiPNG level; ignored for the lossy formats. */
  pngLevel: number;
  /** Longest side in pixels, 0 for the original size. */
  maxSide: number;
}

/**
 * A stable string for "the result these settings produce". Only what the
 * chosen format actually reads goes in, so moving the JPEG slider does not
 * redo the PNGs; and the size goes in as the output size, not the preset, so
 * switching from 3840 to 2560 does not redo an 800-pixel image. `stored` is
 * the size in the file's header; fitting the longest side gives the same
 * answer before and after rotation, so the stored size serves.
 */
export function settingsKey(settings: JobSettings, stored: Size | null): string {
  const dial = settings.format === "png" ? `l${settings.pngLevel}` : `q${settings.quality}`;
  const size = stored
    ? fitWithin(stored.width, stored.height, settings.maxSide, ENCODER_MAX_SIDE[settings.format])
    : null;
  return `${settings.format}:${dial}:${size ? `${size.width}x${size.height}` : `max${settings.maxSide}`}`;
}

/* ---- Geometry -------------------------------------------------------- */

export interface Size {
  width: number;
  height: number;
}

/**
 * The output size: the longest side brought down to `maxSide` (0 = no limit)
 * and to what the encoder can store, aspect ratio kept, never enlarged, never
 * below one pixel.
 */
export function fitWithin(width: number, height: number, maxSide: number, encoderMax = Infinity): Size {
  const limit = Math.min(maxSide > 0 ? maxSide : Infinity, encoderMax);
  const longest = Math.max(width, height);
  if (longest <= limit) return { width, height };
  const scale = limit / longest;
  return {
    width: Math.max(1, Math.min(limit, Math.round(width * scale))),
    height: Math.max(1, Math.min(limit, Math.round(height * scale))),
  };
}

/* ---- Headers --------------------------------------------------------- */

export interface HeaderInfo {
  format: SourceFormat;
  /** Stored (pre-rotation) size when the header was found in the bytes given. */
  width: number | null;
  height: number | null;
  /** More than one frame: the browser decodes only the first, so the rest are lost. */
  animated: boolean;
}

/**
 * How many leading bytes `inspectHeader` wants. JPEG puts its frame header
 * after the EXIF block, and a camera's EXIF with an embedded preview runs to
 * tens of kilobytes; half a megabyte covers every case short of the absurd.
 */
export const HEADER_BYTES = 512 * 1024;

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  at + length <= bytes.length ? String.fromCharCode(...bytes.subarray(at, at + length)) : "";
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
const i32le = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24);
const u32le = (b: Uint8Array, at: number) => i32le(b, at) >>> 0;

const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/**
 * Reads the format and the stored size from the first bytes of a file. The
 * size lets a 200-megapixel panorama be refused before anything tries to
 * decode it into two gigabytes of RGBA; the format lets a HEIC the browser
 * cannot open get an explanation instead of a generic error.
 */
export function inspectHeader(bytes: Uint8Array): HeaderInfo {
  const unknown = (format: SourceFormat): HeaderInfo => ({ format, width: null, height: null, animated: false });
  const sized = (format: SourceFormat, width: number, height: number, animated = false): HeaderInfo =>
    width > 0 && height > 0 ? { format, width, height, animated } : { ...unknown(format), animated };

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return jpegSize(bytes);
  }
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") {
    return ascii(bytes, 12, 4) === "IHDR"
      ? sized("png", u32be(bytes, 16), u32be(bytes, 20), pngAnimated(bytes))
      : unknown("png");
  }
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return bytes.length >= 10 ? sized("gif", u16le(bytes, 6), u16le(bytes, 8), gifAnimated(bytes)) : unknown("gif");
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpSize(bytes);
  if (ascii(bytes, 4, 4) === "ftyp") return isobmff(bytes);
  if (ascii(bytes, 0, 2) === "BM" && bytes.length >= 26) {
    const header = i32le(bytes, 14);
    // BITMAPCOREHEADER stores 16-bit sizes; every later header 32-bit, height negative when top-down.
    return header === 12
      ? sized("bmp", u16le(bytes, 18), u16le(bytes, 20))
      : sized("bmp", Math.abs(i32le(bytes, 18)), Math.abs(i32le(bytes, 22)));
  }
  const tiff = ascii(bytes, 0, 4);
  if (tiff === "II*\0" || tiff === "MM\0*") return unknown("tiff");

  const text = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart();
  if (/^(<\?xml|<svg|<!--|<!doctype svg)/i.test(text) && /<svg[\s>]/i.test(text)) {
    return unknown("svg");
  }
  return unknown("unknown");
}

/** Walks the marker segments to the first start-of-frame. */
function jpegSize(bytes: Uint8Array): HeaderInfo {
  const none: HeaderInfo = { format: "jpeg", width: null, height: null, animated: false };
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return none;
    const marker = bytes[at + 1]!;
    // Fill bytes: any number of 0xFF may precede a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Stand-alone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const length = u16be(bytes, at + 2);
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) break;
      const height = u16be(bytes, at + 5);
      const width = u16be(bytes, at + 7);
      return width > 0 && height > 0 ? { ...none, width, height } : none;
    }
    if (marker === 0xda || length < 2) break;
    at += 2 + length;
  }
  return none;
}

function webpSize(bytes: Uint8Array): HeaderInfo {
  const none: HeaderInfo = { format: "webp", width: null, height: null, animated: false };
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    // Flags byte: 0x02 marks an animation.
    const animated = (bytes[20]! & 0x02) !== 0;
    return { format: "webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, animated };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { ...none, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { ...none, width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return none;
}

/** An APNG announces itself with an acTL chunk before the first image data. */
function pngAnimated(bytes: Uint8Array): boolean {
  let at = 8;
  while (at + 16 <= bytes.length) {
    const type = ascii(bytes, at + 4, 4);
    if (type === "acTL") return u32be(bytes, at + 8) > 1;
    if (type === "IDAT") return false;
    at += 12 + u32be(bytes, at);
  }
  return false;
}

/**
 * Counts GIF frames until a second one turns up. When the bytes run out first
 * — a large first frame can outlast the header read — the looping extension
 * that only animations carry decides; a file that ends after one frame is a
 * still, looping extension or not.
 */
function gifAnimated(bytes: Uint8Array): boolean {
  const packed = bytes[10] ?? 0;
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  let frames = 0;
  let loops = false;
  while (at < bytes.length) {
    const block = bytes[at]!;
    if (block === 0x21) {
      if (bytes[at + 1] === 0xff && bytes[at + 2] === 11) {
        const application = ascii(bytes, at + 3, 11);
        loops ||= application === "NETSCAPE2.0" || application === "ANIMEXTS1.0";
      }
      at = afterSubBlocks(bytes, at + 2);
    } else if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return true;
      const local = bytes[at + 9] ?? 0;
      at += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0);
      // One byte of LZW code size, then the image data.
      at = afterSubBlocks(bytes, at + 1);
    } else {
      // The trailer, or something that is not GIF: either way the count is final.
      return false;
    }
  }
  return loops;
}

/** Skips a chain of GIF sub-blocks: a length byte, that many bytes, until a zero length. */
function afterSubBlocks(bytes: Uint8Array, from: number): number {
  let at = from;
  while (at < bytes.length) {
    const size = bytes[at]!;
    at += 1 + size;
    if (size === 0) return at;
  }
  return Infinity;
}

/**
 * AVIF and HEIC are both ISO-BMFF: tell them apart by the brands in `ftyp`,
 * then look for the image-spatial-extents (`ispe`) properties inside `meta`.
 * A grid image carries one `ispe` per tile and one for the whole; the largest
 * is the one that matters for a memory limit. The `avis` brand marks an image
 * sequence, which is how an animated AVIF is stored.
 */
function isobmff(bytes: Uint8Array): HeaderInfo {
  const ftypSize = u32be(bytes, 0);
  const brands: string[] = [ascii(bytes, 8, 4)];
  for (let at = 16; at + 4 <= Math.min(ftypSize, bytes.length); at += 4) brands.push(ascii(bytes, at, 4));

  const format: SourceFormat = brands.some((brand) => AVIF_BRANDS.has(brand))
    ? "avif"
    : brands.some((brand) => HEIC_BRANDS.has(brand))
      ? "heic"
      : "unknown";
  const animated = format === "avif" && brands.includes("avis");
  if (format === "unknown") return { format, width: null, height: null, animated: false };

  let best: Size | null = null;
  const walk = (start: number, end: number, depth: number) => {
    let at = start;
    while (at + 8 <= end) {
      let size = u32be(bytes, at);
      const type = ascii(bytes, at + 4, 4);
      let header = 8;
      if (size === 1) {
        // 64-bit size; anything past 4 GB is past our bytes anyway.
        if (at + 16 > end) return;
        size = u32be(bytes, at + 8) * 2 ** 32 + u32be(bytes, at + 12);
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header) return;
      const boxEnd = Math.min(at + size, end);
      if (type === "meta" && depth === 0) walk(at + header + 4, boxEnd, depth + 1);
      else if ((type === "iprp" || type === "ipco") && depth > 0) walk(at + header, boxEnd, depth + 1);
      else if (type === "ispe" && at + header + 12 <= boxEnd) {
        const width = u32be(bytes, at + header + 4);
        const height = u32be(bytes, at + header + 8);
        if (!best || width * height > best.width * best.height) best = { width, height };
      }
      at += size;
    }
  };
  walk(0, bytes.length, 0);

  const found = best as Size | null;
  return found && found.width > 0 && found.height > 0
    ? { format, width: found.width, height: found.height, animated }
    : { format, width: null, height: null, animated };
}

/* ---- Files ----------------------------------------------------------- */

const IMAGE_EXTENSIONS = /\.(jpe?g|jfif|png|apng|gif|webp|avif|bmp|dib|heic|heif|tiff?|svg)$/i;

/**
 * Whether a dropped file is worth a row. A folder dragged in brings along
 * `.DS_Store` and a PDF or two; those are counted and left out rather than
 * listed as failures.
 */
export function looksLikeImage(name: string, type: string): boolean {
  return type.startsWith("image/") || IMAGE_EXTENSIONS.test(name);
}

/**
 * The visitor's own file name with the new extension. The name is theirs —
 * "Düğün 014.JPG" stays "Düğün 014" — only characters that no filesystem
 * accepts are replaced.
 */
export function outputFilename(name: string, format: EncodedFormat): string {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "-")
    .replace(/[. ]+$/, "")
    .trim();
  return `${base || "image"}.${EXTENSION[format]}`;
}

/* ---- Pixels ---------------------------------------------------------- */

/**
 * Composites RGBA over white in place and reports whether anything was
 * transparent. JPEG has no alpha channel; handed straight to an encoder, a
 * transparent logo comes out on black, which nobody wants.
 */
export function flattenOnWhite(data: Uint8ClampedArray | Uint8Array): boolean {
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i]!;
    if (alpha === 255) continue;
    transparent = true;
    const keep = alpha / 255;
    const fill = 255 * (1 - keep);
    data[i - 3] = Math.round(data[i - 3]! * keep + fill);
    data[i - 2] = Math.round(data[i - 2]! * keep + fill);
    data[i - 1] = Math.round(data[i - 1]! * keep + fill);
    data[i] = 255;
  }
  return transparent;
}

/* ---- Results --------------------------------------------------------- */

/** Share of the original saved: 0.75 means three quarters smaller, negative means larger. */
export function savedRatio(before: number, after: number): number {
  if (before <= 0) return 0;
  return (before - after) / before;
}

/** Under half a percent either way reads as no change: "%0 daha küçük" helps nobody. */
const NEGLIGIBLE = 0.005;

export type SizeChange = { kind: "same" } | { kind: "smaller" | "larger"; share: number };

/**
 * How a size change is worded. A saving stops at 99 %, because an 18 MB
 * bitmap that became an 848-byte PNG, rounded to "100 % smaller", reads as an
 * empty file.
 */
export function sizeChange(before: number, after: number): SizeChange {
  const ratio = savedRatio(before, after);
  if (Math.abs(ratio) < NEGLIGIBLE) return { kind: "same" };
  return ratio > 0 ? { kind: "smaller", share: Math.min(ratio, 0.99) } : { kind: "larger", share: -ratio };
}

/* ---- Metadata -------------------------------------------------------- */

/**
 * EXIF orientation read the way Chromium reads it: IFD0 of a TIFF structure,
 * tag 0x0112 as a single SHORT; a value outside 1–8 counts as upright. Null
 * when there is no such tag.
 */
function readOrientation(tiff: Uint8Array): number | null {
  const order = ascii(tiff, 0, 2);
  const little = order === "II";
  if (!little && order !== "MM") return null;
  const u16 = (at: number) => (little ? u16le(tiff, at) : u16be(tiff, at));
  const u32 = (at: number) => (little ? u32le(tiff, at) : u32be(tiff, at));
  if (tiff.length < 8 || u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return null;
}

/** An EXIF segment that says nothing but which way is up. */
function orientationSegment(orientation: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22,                         // APP1, 34 bytes
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,             // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD0 at 8
    0x00, 0x01,                                     // one entry:
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, //   Orientation, SHORT × 1
    0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,                         // no further IFD
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The end of entropy-coded data: the next marker that is not a restart, a stuffed zero or fill. */
function entropyEnd(bytes: Uint8Array, from: number): number {
  let at = from;
  for (;;) {
    at = bytes.indexOf(0xff, at);
    if (at < 0 || at + 1 >= bytes.length) return bytes.length;
    const next = bytes[at + 1]!;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
    else if (next === 0xff) at += 1;
    else return at;
  }
}

/**
 * Keeps what a decoder needs — tables, frame, scans, the colour profile and
 * Adobe's colour-transform flag — and drops every APPn and comment besides:
 * EXIF, XMP, IPTC, maker notes, embedded previews. Whatever follows the
 * picture's end marker goes too; phones append a second picture or a video
 * there, each with metadata of its own. Rotation survives as a bare
 * orientation tag, so the photo still stands the right way up.
 */
function stripJpeg(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  const kept: Uint8Array[] = [];
  let jfif: Uint8Array | null = null;
  let orientation: number | null = null;
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff || at + 1 >= bytes.length) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd9) {
      kept.push(bytes.subarray(at, at + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      kept.push(bytes.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > bytes.length) return null;
    const end = at + 2 + u16be(bytes, at + 2);
    if (end < at + 4 || end > bytes.length) return null;
    const body = bytes.subarray(at + 4, end);

    if (marker === 0xe0 && ascii(body, 0, 5) === "JFIF\0" && body.length >= 14) {
      // JFIF stays for its pixel density, but without the thumbnail it may carry.
      jfif ??= concat([new Uint8Array([0xff, 0xe0, 0x00, 0x10]), body.subarray(0, 12), new Uint8Array(2)]);
    } else if (marker === 0xe1 && ascii(body, 0, 6) === "Exif\0\0") {
      orientation ??= readOrientation(body.subarray(6));
    } else if (marker === 0xe2 && ascii(body, 0, 12) === "ICC_PROFILE\0") {
      kept.push(bytes.subarray(at, end));
    } else if (marker === 0xee && ascii(body, 0, 5) === "Adobe") {
      kept.push(bytes.subarray(at, end));
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
      kept.push(bytes.subarray(at, end));
    }
    at = end;

    if (marker === 0xda) {
      const scanEnd = entropyEnd(bytes, at);
      kept.push(bytes.subarray(at, scanEnd));
      at = scanEnd;
    }
  }
  const head: Uint8Array[] = [bytes.subarray(0, 2)];
  if (jfif) head.push(jfif);
  if (orientation !== null && orientation !== 1) head.push(orientationSegment(orientation));
  return concat([...head, ...kept]);
}

/** Ancillary PNG chunks that change how the picture looks or moves; every other one is metadata. */
const PNG_KEEP = new Set([
  "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCV", "cLLI", "mDCv", "cLLi", "bKGD", "pHYs",
  "acTL", "fcTL", "fdAT",
]);

/**
 * Drops text, time and EXIF chunks. A PNG whose EXIF turns the picture is
 * left alone: engines disagree on whether to honour it, so removing it could
 * change what the visitor sees.
 */
function stripPng(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const end = at + 12 + u32be(bytes, at);
    if (end > bytes.length) return null;
    const type = ascii(bytes, at + 4, 4);
    if (type === "eXIf" && (readOrientation(bytes.subarray(at + 8, end - 4)) ?? 1) !== 1) return null;
    // A lower-case first letter marks an ancillary chunk; the critical ones always stay.
    const critical = (bytes[at + 4]! & 0x20) === 0;
    if (critical || PNG_KEEP.has(type)) kept.push(bytes.subarray(at, end));
    at = end;
    if (type === "IEND") return concat(kept);
  }
  return null;
}

const WEBP_KEEP = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);

/**
 * Drops the EXIF and XMP chunks of an extended WebP and clears their flags. A
 * simple WebP has nowhere to keep metadata. The same caution about rotation as
 * for PNG applies.
 */
function stripWebp(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  if (ascii(bytes, 12, 4) !== "VP8X") return bytes;
  const limit = Math.min(bytes.length, 8 + u32le(bytes, 4));
  const kept: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= limit) {
    const size = u32le(bytes, at + 4);
    const type = ascii(bytes, at, 4);
    if (at + 8 + size > limit) return null;
    if (type === "EXIF") {
      const exif = bytes.subarray(at + 8, at + 8 + size);
      const tiff = ascii(exif, 0, 6) === "Exif\0\0" ? exif.subarray(6) : exif;
      if ((readOrientation(tiff) ?? 1) !== 1) return null;
    }
    const end = Math.min(at + 8 + size + (size & 1), limit);
    if (WEBP_KEEP.has(type)) kept.push(bytes.subarray(at, end));
    at = end;
  }
  const body = concat(kept);
  if (ascii(body, 0, 4) !== "VP8X" || body.length < 18) return null;
  // VP8X flags: 0x08 EXIF, 0x04 XMP.
  body[8] = body[8]! & ~0x0c;
  const header = concat([bytes.subarray(0, 12)]);
  const riffSize = 4 + body.length;
  header.set([riffSize & 0xff, (riffSize >>> 8) & 0xff, (riffSize >>> 16) & 0xff, riffSize >>> 24], 4);
  return concat([header, body]);
}

/**
 * The file with its metadata taken out and its picture untouched — for when
 * the visitor keeps an original because re-encoding made it bigger, and the
 * page has promised that EXIF and GPS go. Null when that cannot be done
 * safely for this file (AVIF, GIF, HEIC, a damaged file): the caller then has
 * to say that the original travels as it is.
 */
export function stripMetadata(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  switch (inspectHeader(bytes.subarray(0, HEADER_BYTES)).format) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    case "webp":
      return stripWebp(bytes);
    case "bmp":
      return bytes;
    default:
      return null;
  }
}

/* ---- Scheduling ------------------------------------------------------ */

/**
 * Whether another job may start. Each running job holds its source frame, a
 * resized copy and the encoder's own copy in memory, so concurrency is capped
 * by pixels as well as by count — three 48 MP photos at once would take a
 * phone's tab down. One job always runs, however large, or a single big file
 * would wait for ever.
 */
export function canStartJob(
  runningPixels: readonly number[],
  nextPixels: number,
  budget: number,
  maxJobs: number,
): boolean {
  if (runningPixels.length === 0) return true;
  if (runningPixels.length >= maxJobs) return false;
  const used = runningPixels.reduce((sum, pixels) => sum + pixels, 0);
  return used + nextPixels <= budget;
}
