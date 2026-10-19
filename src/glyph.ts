/**
 * Emoji become 8×8 glyphs. Known pictures are drawn by hand.
 * Anything else still becomes a stable picture, so a new emoji compiles.
 * The C64 and TI-99/4A can show that picture as a hardware sprite.
 * The Apple II has no sprite chip. The same picture is plotted in lo-res.
 */

export interface Glyph {
  emoji: string;
  /** Eight rows. Bit 7 is the left pixel. */
  bits: number[];
  /** Index into the machine palette. */
  color: number;
  /** One ASCII character for Apple text and for listings. */
  ascii: string;
}

export type TargetName = 'c64' | 'apple2' | 'ti99';

const HAND: Record<string, { hex: string; color: number; ascii: string }> = {
  '✦': { hex: '18247E1818244200', color: 7, ascii: '*' },
  '✧': { hex: '1824241818242400', color: 7, ascii: '*' },
  '★': { hex: '107C381010281000', color: 7, ascii: '*' },
  '⭐': { hex: '107C381010281000', color: 7, ascii: '*' },
  '🌟': { hex: '107C7C3810384400', color: 7, ascii: '*' },
  '●': { hex: '3C7EFFFFFF7E3C00', color: 10, ascii: 'O' },
  '○': { hex: '3C42818181423C00', color: 1, ascii: 'o' },
  '■': { hex: '00FEFEFEFEFEFE00', color: 2, ascii: '#' },
  '□': { hex: '00FE8282828282FE', color: 1, ascii: '#' },
  '▲': { hex: '081838387C7CFFFF', color: 7, ascii: '^' },
  '▼': { hex: 'FF7E7E3C3C181800', color: 8, ascii: 'v' },
  '◀': { hex: '103070F0F0703010', color: 14, ascii: '<' },
  '▶': { hex: '08180C0F0F0C1808', color: 14, ascii: '>' },
  '◆': { hex: '18183C7E3C181800', color: 4, ascii: '+' },
  '♦': { hex: '10387CFE7C381000', color: 2, ascii: '+' },
  '♥': { hex: '663C7EFFFFFF7E3C', color: 2, ascii: 'H' },
  '❤': { hex: '663C7EFFFFFF7E3C', color: 2, ascii: 'H' },
  '❤️': { hex: '663C7EFFFFFF7E3C', color: 2, ascii: 'H' },
  '🔥': { hex: '2418387C7EFE7C38', color: 8, ascii: 'f' },
  '💧': { hex: '1818387C7C7C3800', color: 14, ascii: 'o' },
  '⚡': { hex: '183060F81C0C1800', color: 7, ascii: '!' },
  '☀': { hex: '925438FE38549200', color: 7, ascii: 'o' },
  '☀️': { hex: '925438FE38549200', color: 7, ascii: 'o' },
  '🌙': { hex: '70F8F8F070200000', color: 7, ascii: ')' },
  '🚀': { hex: '18183C7E3C182442', color: 2, ascii: '^' },
  '👾': { hex: '3C7EFFABFF7E2400', color: 4, ascii: 'A' },
  '👻': { hex: '3C7EFFFFFFDB0000', color: 1, ascii: 'G' },
  '💀': { hex: '3C7EC3DBE77E3C00', color: 1, ascii: 'S' },
  '😀': { hex: '3C42A581A599423C', color: 7, ascii: ':' },
  '😎': { hex: '3C42FF81A599423C', color: 14, ascii: 'B' },
  '🐱': { hex: '66FFBDFF8181423C', color: 8, ascii: 'c' },
  '🐶': { hex: '42E7BDBD9981423C', color: 8, ascii: 'd' },
  '🐸': { hex: '66FFA5A58199423C', color: 5, ascii: 'f' },
  '🐍': { hex: '3C7E5A7E3C7E1800', color: 5, ascii: 's' },
  '🐟': { hex: '3E7F7F3E0C183000', color: 14, ascii: '<' },
  '🐝': { hex: '24187EBD7E3C2400', color: 7, ascii: 'b' },
  '🐉': { hex: '3C7EFFE77E3C4200', color: 5, ascii: 'D' },
  '🧙': { hex: '183C7E5A7E3C1800', color: 4, ascii: 'W' },
  '👑': { hex: 'ABFFFFFFD67E3C00', color: 7, ascii: 'K' },
  '💎': { hex: '3C7EDBFF7E3C1800', color: 14, ascii: 'D' },
  '🪙': { hex: '3C7EBDBD7E3C0000', color: 7, ascii: 'o' },
  '🏆': { hex: '3C7E3C18187E0000', color: 7, ascii: 'T' },
  '🎯': { hex: '3C42FF995A241800', color: 2, ascii: 'o' },
  '🍎': { hex: '083C7EFFFFFF7E3C', color: 2, ascii: 'a' },
  '🍒': { hex: '08143C3C7E7E3C3C', color: 2, ascii: 'a' },
  '🌳': { hex: '183C7E7E3C181818', color: 5, ascii: 'T' },
  '🌸': { hex: '5A3C7E3C5A180000', color: 10, ascii: '*' },
  '🍀': { hex: '367E367E363C1800', color: 5, ascii: '*' },
  '🏠': { hex: '183C7EFFE7E7E700', color: 8, ascii: 'H' },
  '🚗': { hex: '003C7EFFFFFF7E00', color: 2, ascii: 'C' },
  '✈': { hex: '00187EFF7E180000', color: 1, ascii: '^' },
  '✈️': { hex: '00187EFF7E180000', color: 1, ascii: '^' },
  '💣': { hex: '3C7EFFFFFF7E2418', color: 12, ascii: 'o' },
  '🔔': { hex: '183C3C7E7E181800', color: 7, ascii: 'b' },
  '🎵': { hex: '0C0C0C3C7C3C0000', color: 3, ascii: 'n' },
  '🎾': { hex: '3C7EDBFF7E3C0000', color: 13, ascii: 'o' },
  '🏀': { hex: '3C7EDBFF7E3C0000', color: 8, ascii: 'o' },
  '⚽': { hex: '3C7EFFFF7E3C0000', color: 1, ascii: 'o' },
  '🧙‍♂️': { hex: '183C7E5A7E3C1800', color: 4, ascii: 'W' },
};

function parseHex(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const rows: number[] = [];
  for (let i = 0; i < 8; i += 1) rows.push(Number.parseInt(clean.slice(i * 2, i * 2 + 2) || '00', 16) & 0xff);
  return rows;
}

function normalize(emoji: string): string {
  return [...emoji].filter((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp !== 0xfe0f && cp !== 0x200d;
  }).join('');
}

function procedural(emoji: string): number[] {
  let h = 2166136261;
  for (const ch of emoji) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const rows: number[] = [];
  for (let y = 0; y < 8; y += 1) {
    let row = 0;
    for (let x = 0; x < 8; x += 1) {
      const border = x === 0 || y === 0 || x === 7 || y === 7;
      const bit = (h >>> ((x * 3 + y * 5) & 31)) & 1;
      const on = border ? ((h >>> (x + y)) & 1) === 1 : bit === 1;
      if (on) row |= 1 << (7 - x);
    }
    rows.push(row);
    h = Math.imul(h ^ (y + 1), 16777619) >>> 0;
  }
  return rows;
}

export function isEmojiGrapheme(grapheme: string): boolean {
  const n = normalize(grapheme);
  if (!n) return false;
  if (HAND[grapheme] || HAND[n]) return true;
  const points = [...n].map((ch) => ch.codePointAt(0) ?? 0);
  if (points.some((cp) => cp >= 0x1f000)) return true;
  if (points.length === 1) {
    const cp = points[0] ?? 0;
    if (cp >= 0x2190 && cp <= 0x2bff) return true;
    if (cp >= 0x2600 && cp <= 0x27bf) return true;
  }
  return false;
}

export function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, opts?: { granularity: 'grapheme' }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
  return [...text];
}

export function glyphFor(emoji: string): Glyph {
  const n = normalize(emoji);
  const hand = HAND[emoji] ?? HAND[n];
  if (hand) {
    return { emoji, bits: parseHex(hand.hex), color: hand.color, ascii: hand.ascii };
  }
  let h = 2166136261;
  for (const ch of n || emoji) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const ascii = String.fromCharCode(65 + (h % 26));
  return { emoji, bits: procedural(n || emoji), color: (h % 14) + 1, ascii };
}

/** Split a string into plain runs and emoji glyphs. */
export function scanText(text: string): Array<{ kind: 'text'; text: string } | { kind: 'emoji'; glyph: Glyph }> {
  const out: Array<{ kind: 'text'; text: string } | { kind: 'emoji'; glyph: Glyph }> = [];
  let plain = '';
  for (const g of graphemes(text)) {
    if (isEmojiGrapheme(g)) {
      if (plain) out.push({ kind: 'text', text: plain });
      plain = '';
      out.push({ kind: 'emoji', glyph: glyphFor(g) });
    } else plain += g;
  }
  if (plain) out.push({ kind: 'text', text: plain });
  return out;
}

/** C64 VIC-II sprite: 24×21, three bytes a row, plus the pad byte. 64 bytes. */
export function c64Sprite(bits: number[]): number[] {
  const out: number[] = [];
  for (let y = 0; y < 21; y += 1) {
    const src = bits[Math.min(7, Math.floor((y * 8) / 21))] ?? 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let x = 0; x < 8; x += 1) {
      const on = (src >> (7 - x)) & 1;
      if (!on) continue;
      for (let k = 0; k < 3; k += 1) {
        const dx = x * 3 + k;
        if (dx < 8) b0 |= 1 << (7 - dx);
        else if (dx < 16) b1 |= 1 << (15 - dx);
        else b2 |= 1 << (23 - dx);
      }
    }
    out.push(b0 & 0xff, b1 & 0xff, b2 & 0xff);
  }
  out.push(0);
  return out;
}

export function tiHex(bits: number[]): string {
  return bits.map((row) => row.toString(16).padStart(2, '0').toUpperCase()).join('');
}

export const PALETTE: Record<TargetName, string[]> = {
  c64: [
    '#000000', '#ffffff', '#883932', '#67b6bd', '#8b3f96', '#55a049', '#40318d', '#bfce72',
    '#8b5429', '#574200', '#b86962', '#505050', '#787878', '#94e089', '#7869c4', '#9f9f9f',
  ],
  apple2: [
    '#000000', '#722640', '#40337f', '#e434fe', '#0e5940', '#808080', '#1b9afe', '#bfb3ff',
    '#404c00', '#e46501', '#808080', '#f1a6bf', '#1bcb01', '#bfcc80', '#8dd9bf', '#ffffff',
  ],
  ti99: [
    '#000000', '#000000', '#1eb01e', '#4cdf4c', '#0000ba', '#3f3fff', '#b00000', '#1cffff',
    '#ff1c1c', '#ff6e6e', '#b0b000', '#e4e41c', '#1c9e1c', '#e41cdf', '#b0b0b0', '#ffffff',
  ],
};

export function paint(target: TargetName, index: number): string {
  const palette = PALETTE[target];
  const i = ((index % palette.length) + palette.length) % palette.length;
  return palette[i] ?? '#ffffff';
}

export const MACHINE = {
  c64: {
    name: 'Commodore 64',
    cols: 40,
    rows: 25,
    pixelWidth: 320,
    pixelHeight: 200,
    border: 14,
    background: 6,
    foreground: 1,
    sprites: 8,
    hardwareSprites: true,
    cpu: '6502' as const,
  },
  apple2: {
    name: 'Apple II',
    cols: 40,
    rows: 24,
    pixelWidth: 280,
    pixelHeight: 192,
    loresCols: 40,
    loresRows: 48,
    border: 0,
    background: 0,
    foreground: 15,
    sprites: 0,
    hardwareSprites: false,
    cpu: '6502' as const,
  },
  ti99: {
    name: 'TI-99/4A',
    cols: 32,
    rows: 24,
    pixelWidth: 256,
    pixelHeight: 192,
    border: 4,
    background: 4,
    foreground: 16,
    sprites: 32,
    hardwareSprites: true,
    cpu: '9900' as const,
  },
} as const;

export const TARGETS: TargetName[] = ['c64', 'apple2', 'ti99'];

export function machineOf(target: TargetName) {
  return MACHINE[target];
}
