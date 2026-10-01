// Builds a minimal but valid PMTiles v3 archive in memory, so the Worker tests
// need no binary fixture files. Layout: 127-byte header, one gzip root
// directory (no leaf directories), gzip JSON metadata, then the tile data.

import { gzipSync } from 'node:zlib';
import { zxyToTileId } from 'pmtiles';

export interface FixtureTile {
  z: number;
  x: number;
  y: number;
  /** Stored as-is; the Worker never looks inside, so tests pass gzip bytes. */
  data: Uint8Array;
}

/** gzip a string, the way a Protomaps archive stores a tile. */
export const gz = (text: string): Buffer => gzipSync(Buffer.from(text));

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export function buildArchive(
  tiles: FixtureTile[],
  opts: { minZoom: number; maxZoom: number; name?: string },
): Buffer {
  const sorted = tiles
    .map((t) => ({ ...t, id: zxyToTileId(t.z, t.x, t.y) }))
    .sort((a, b) => a.id - b.id);

  const entries: { id: number; offset: number; length: number }[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const t of sorted) {
    entries.push({ id: t.id, offset, length: t.data.length });
    chunks.push(Buffer.from(t.data));
    offset += t.data.length;
  }
  const tileData = Buffer.concat(chunks);

  // Directory: entry count, tile-id deltas, run lengths, lengths, offsets
  // (0 when an entry starts where the previous one ended, else offset + 1).
  const dir: number[] = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) {
    dir.push(...varint(e.id - last));
    last = e.id;
  }
  for (let i = 0; i < entries.length; i++) dir.push(...varint(1));
  for (const e of entries) dir.push(...varint(e.length));
  entries.forEach((e, i) => {
    const contiguous = i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length;
    dir.push(...(contiguous ? [0] : varint(e.offset + 1)));
  });
  const rootDir = gzipSync(Buffer.from(dir));
  const metadata = gzipSync(Buffer.from(JSON.stringify({ name: opts.name ?? 'fixture', attribution: 'test' })));

  const HEADER = 127;
  const rootOffset = HEADER;
  const metaOffset = rootOffset + rootDir.length;
  const dataOffset = metaOffset + metadata.length;

  const header = Buffer.alloc(HEADER);
  header.write('PMTiles', 0, 'latin1');
  header.writeUInt8(3, 7);
  const u64 = (at: number, v: number) => {
    header.writeUInt32LE(v % 2 ** 32, at);
    header.writeUInt32LE(Math.floor(v / 2 ** 32), at + 4);
  };
  u64(8, rootOffset);
  u64(16, rootDir.length);
  u64(24, metaOffset);
  u64(32, metadata.length);
  u64(40, 0); // no leaf directories
  u64(48, 0);
  u64(56, dataOffset);
  u64(64, tileData.length);
  u64(72, entries.length);
  u64(80, entries.length);
  u64(88, entries.length);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(2, 97); // internal compression: gzip
  header.writeUInt8(2, 98); // tile compression: gzip
  header.writeUInt8(1, 99); // tile type: MVT
  header.writeUInt8(opts.minZoom, 100);
  header.writeUInt8(opts.maxZoom, 101);
  header.writeInt32LE(-1067000000, 102); // -106.7
  header.writeInt32LE(258000000, 106); // 25.8
  header.writeInt32LE(-935000000, 110); // -93.5
  header.writeInt32LE(366000000, 114); // 36.6
  header.writeUInt8(0, 118);
  header.writeInt32LE(-1001000000, 119);
  header.writeInt32LE(312000000, 123);

  return Buffer.concat([header, rootDir, metadata, tileData]);
}
