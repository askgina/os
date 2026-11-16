/**
 * Draws the app's icons as PNG files in `public/icons/`, from the same shapes as
 * `public/favicon.svg`: a blue square with rounded corners (radius 7 of 32) and a white check
 * mark (the path `M10 16.5 l4 4 8-9`, 3 units wide, round ends). Run it after changing that design:
 *
 *     node dev/icons.ts
 *
 * - `icon-192.png`, `icon-512.png`: the favicon as it is, for the manifest's `any` purpose.
 * - `icon-maskable-512.png`: square corners, for `maskable`; the check mark stays well inside
 *   the safe circle (40% of the size around the centre), so any mask keeps it whole.
 * - `apple-touch-icon.png` (180): square corners and no transparency, since iOS rounds the
 *   corners itself and shows transparent pixels as black.
 *
 * No image library: each pixel is sampled 4 × 4 times against the two shapes, and the file is
 * written with `node:zlib`. Nothing here is part of the built UI.
 */
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const BLUE = [0x1d, 0x4e, 0xd8] as const;

/** The check mark's three points: two strokes, from the first to the second to the third. */
const CHECK: [[number, number], [number, number], [number, number]] = [
  [10, 16.5],
  [14, 20.5],
  [22, 11.5],
];

const HALF_STROKE = 1.5;

const SAMPLES = 4;

function insideRoundedSquare(x: number, y: number, radius: number): boolean {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false;
  const cx = Math.min(Math.max(x, radius), 32 - radius);
  const cy = Math.min(Math.max(y, radius), 32 - radius);

  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(x: number, y: number, a: [number, number], b: [number, number]) {
  const [ax, ay] = a;
  const [bx, by] = b;
  const length = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length));

  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

function onCheck(x: number, y: number): boolean {
  const [start, corner, end] = CHECK;

  return (
    distanceToSegment(x, y, start, corner) <= HALF_STROKE ||
    distanceToSegment(x, y, corner, end) <= HALF_STROKE
  );
}

/** RGBA rows, each led by PNG filter byte 0. */
function draw(size: number, radius: number): Buffer {
  const scale = 32 / size;
  const rows = Buffer.alloc(size * (size * 4 + 1));

  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);

    for (let px = 0; px < size; px++) {
      let square = 0;
      let white = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;

          if (!insideRoundedSquare(x, y, radius)) continue;
          square++;

          if (onCheck(x, y)) white++;
        }
      }

      const total = SAMPLES * SAMPLES;
      const share = square === 0 ? 0 : white / square;
      const offset = row + 1 + px * 4;

      for (const [channel, blue] of BLUE.entries()) {
        rows[offset + channel] = Math.round(blue + (255 - blue) * share);
      }

      rows[offset + 3] = Math.round((255 * square) / total);
    }
  }

  return rows;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);

  return Buffer.concat([head, data, tail]);
}

function png(size: number, radius: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(draw(size, radius), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/icons/", import.meta.url);

for (const [name, size, radius] of [
  ["icon-192.png", 192, 7],
  ["icon-512.png", 512, 7],
  ["icon-maskable-512.png", 512, 0],
  ["apple-touch-icon.png", 180, 0],
] as const) {
  writeFileSync(new URL(name, out), png(size, radius));
}
