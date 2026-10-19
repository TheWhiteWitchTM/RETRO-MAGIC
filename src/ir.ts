/**
 * The retro program is what every backend shares.
 * BASIC, 6502, and TMS9900 are three ways to write this down.
 * `runProgram` is the host that the IDE screen uses.
 */

import { RetroError } from './error.js';
import { MACHINE, PALETTE, paint, type TargetName } from './glyph.js';

export type { TargetName };

export type RExpr =
  | { t: 'n'; n: number }
  | { t: 's'; s: string }
  | { t: 'v'; name: string; str: boolean }
  | { t: 'bin'; op: string; a: RExpr; b: RExpr }
  | { t: 'un'; op: '-' | 'not'; a: RExpr }
  | { t: 'fn'; name: 'len' | 'abs' | 'int' | 'val' | 'str' | 'chr' | 'asc' | 'sgn' | 'peek'; args: RExpr[] };

export type RStmt =
  | { t: 'rem'; text: string }
  | { t: 'let'; name: string; str: boolean; expr: RExpr }
  | { t: 'print'; args: RExpr[] }
  | { t: 'if'; cond: RExpr; yes: RStmt[]; no: RStmt[] }
  | { t: 'for'; name: string; from: RExpr; to: RExpr; step: RExpr; body: RStmt[] }
  | { t: 'while'; cond: RExpr; body: RStmt[] }
  | { t: 'repeat'; body: RStmt[]; cond: RExpr }
  | { t: 'break' }
  | { t: 'continue' }
  | { t: 'return'; expr: RExpr | null }
  | { t: 'gosub'; fn: string; args: Array<{ name: string; str: boolean; expr: RExpr }>; ret: { name: string; str: boolean } | null }
  | { t: 'sprite'; id: number }
  | { t: 'motion'; id: number; dx: RExpr; dy: RExpr }
  | { t: 'update' }
  | { t: 'tone'; freq: RExpr; ms: RExpr; kind: 'tone' | 'noise' }
  | { t: 'cls' }
  | { t: 'locate'; col: RExpr; row: RExpr }
  | { t: 'write'; text: RExpr }
  | { t: 'poke'; addr: RExpr; value: RExpr };

export interface RFn {
  name: string;
  params: Array<{ name: string; str: boolean }>;
  ret: { name: string; str: boolean } | null;
  body: RStmt[];
  line: number;
  column: number;
}

export interface RSprite {
  id: number;
  emoji: string;
  label: string;
  x: string;
  y: string;
  dx: string;
  dy: string;
  size: string;
  alive: string;
  color: number;
  bits: number[];
  ascii: string;
  hardware: boolean;
}

export interface RProg {
  target: TargetName;
  filename: string;
  main: RStmt[];
  fns: RFn[];
  sprites: RSprite[];
  /** Runs when two living sprites overlap. */
  hit: RStmt[];
  warnings: string[];
  width: number;
  height: number;
  cols: number;
  rows: number;
  notes: string[];
}

export interface ScreenCell {
  ch: string;
  fg: string;
  bg: string;
  bits: number[] | null;
}

export interface ScreenSprite {
  emoji: string;
  x: number;
  y: number;
  size: number;
  bits: number[];
  color: string;
  hardware: boolean;
  label: string;
}

export interface ScreenModel {
  target: TargetName;
  title: string;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  border: string;
  background: string;
  foreground: string;
  cells: ScreenCell[];
  sprites: ScreenSprite[];
  palette: string[];
  output: string;
  sounds: Array<{ freq: number; ms: number; kind: string }>;
  hardwareSprites: boolean;
  caption: string;
}

class Flow extends Error {
  constructor(readonly kind: 'break' | 'continue' | 'return', readonly value: number | string | null = null) {
    super(kind);
  }
}

function truthy(value: number | string | null): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value !== '';
  return value !== 0;
}

function asNumber(value: number | string | null): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asText(value: number | string | null): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function evalExpr(expr: RExpr, get: (name: string) => number | string | null): number | string | null {
  switch (expr.t) {
    case 'n':
      return expr.n;
    case 's':
      return expr.s;
    case 'v':
      return get(expr.name);
    case 'fn': {
      const arg = expr.args[0] ? evalExpr(expr.args[0], get) : 0;
      const n = asNumber(arg);
      switch (expr.name) {
        case 'len':
          return typeof arg === 'string' ? [...arg].length : 0;
        case 'abs':
          return Math.abs(n);
        case 'int':
          return Math.trunc(n);
        case 'sgn':
          return n < 0 ? -1 : n > 0 ? 1 : 0;
        case 'val':
          return asNumber(arg);
        case 'str':
          return asText(arg);
        case 'chr':
          return String.fromCharCode(Math.trunc(n) & 0xff);
        case 'asc':
          return (asText(arg).codePointAt(0) ?? 0) & 0xff;
        case 'peek':
          return 0;
        default:
          return 0;
      }
    }
    case 'un': {
      const n = asNumber(evalExpr(expr.a, get));
      if (expr.op === '-') return -n;
      return truthy(evalExpr(expr.a, get)) ? 0 : 1;
    }
    case 'bin': {
      if (expr.op === '&') return asText(evalExpr(expr.a, get)) + asText(evalExpr(expr.b, get));
      if (expr.op === 'and') return truthy(evalExpr(expr.a, get)) && truthy(evalExpr(expr.b, get)) ? 1 : 0;
      if (expr.op === 'or') return truthy(evalExpr(expr.a, get)) || truthy(evalExpr(expr.b, get)) ? 1 : 0;
      const left = evalExpr(expr.a, get);
      const right = evalExpr(expr.b, get);
      if (expr.op === '==' || expr.op === '=') {
        if (typeof left === 'string' || typeof right === 'string') return asText(left) === asText(right) ? 1 : 0;
        return asNumber(left) === asNumber(right) ? 1 : 0;
      }
      if (expr.op === '!=' || expr.op === '<>') {
        if (typeof left === 'string' || typeof right === 'string') return asText(left) !== asText(right) ? 1 : 0;
        return asNumber(left) !== asNumber(right) ? 1 : 0;
      }
      const a = asNumber(left);
      const b = asNumber(right);
      switch (expr.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? 0 : a / b;
        case '%':
          return b === 0 ? 0 : a - Math.trunc(a / b) * b;
        case '<':
          return a < b ? 1 : 0;
        case '>':
          return a > b ? 1 : 0;
        case '<=':
          return a <= b ? 1 : 0;
        case '>=':
          return a >= b ? 1 : 0;
        default:
          return 0;
      }
    }
    default:
      return 0;
  }
}

function circles(ax: number, ay: number, asize: number, bx: number, by: number, bsize: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const reach = asize / 2 + bsize / 2;
  return dx * dx + dy * dy <= reach * reach;
}

export function runProgram(prog: RProg): ScreenModel {
  const machine = MACHINE[prog.target];
  const vars = new Map<string, number | string | null>();
  const fns = new Map(prog.fns.map((fn) => [fn.name, fn]));
  let output = '';
  const sounds: ScreenModel['sounds'] = [];
  const cols = prog.cols;
  const rows = prog.rows;
  const bg = paint(prog.target, machine.background);
  const fg = paint(prog.target, machine.foreground);
  const cells: ScreenCell[] = Array.from({ length: cols * rows }, () => ({ ch: ' ', fg, bg, bits: null }));
  let cursor = 0;

  const get = (name: string): number | string | null => (vars.has(name) ? vars.get(name) ?? null : null);
  const put = (name: string, value: number | string | null): void => {
    vars.set(name, value);
  };
  const num = (expr: RExpr): number => asNumber(evalExpr(expr, get));
  const text = (expr: RExpr): string => asText(evalExpr(expr, get));

  const writeChar = (ch: string, bits: number[] | null = null): void => {
    if (ch === '\n') {
      cursor = (Math.floor(cursor / cols) + 1) * cols;
      return;
    }
    if (cursor >= cells.length) return;
    const cell = cells[cursor];
    if (cell) {
      cell.ch = ch;
      cell.bits = bits;
      cell.fg = fg;
    }
    cursor += 1;
  };

  const writeText = (value: string): void => {
    for (const ch of value) writeChar(ch);
  };

  const exec = (stmts: RStmt[]): void => {
    for (const stmt of stmts) execOne(stmt);
  };

  const callFn = (fn: RFn, args: Array<{ name: string; str: boolean; expr: RExpr }>, ret: { name: string; str: boolean } | null): void => {
    for (const arg of args) put(arg.name, evalExpr(arg.expr, get));
    try {
      exec(fn.body);
      if (ret) put(ret.name, ret.str ? '' : 0);
    } catch (error) {
      if (error instanceof Flow && error.kind === 'return') {
        if (ret) put(ret.name, error.value);
        return;
      }
      throw error;
    }
  };

  const spriteNum = (slot: string): number => asNumber(get(slot));

  const doUpdate = (): void => {
    for (const sprite of prog.sprites) {
      if (spriteNum(sprite.alive) === 0) continue;
      put(sprite.x, spriteNum(sprite.x) + spriteNum(sprite.dx));
      put(sprite.y, spriteNum(sprite.y) + spriteNum(sprite.dy));
    }
    if (prog.hit.length === 0) return;
    for (let i = 0; i < prog.sprites.length; i += 1) {
      for (let j = i + 1; j < prog.sprites.length; j += 1) {
        const a = prog.sprites[i];
        const b = prog.sprites[j];
        if (!a || !b) continue;
        if (spriteNum(a.alive) === 0 || spriteNum(b.alive) === 0) continue;
        if (!circles(spriteNum(a.x), spriteNum(a.y), spriteNum(a.size), spriteNum(b.x), spriteNum(b.y), spriteNum(b.size))) continue;
        exec(prog.hit);
      }
    }
  };

  const execOne = (stmt: RStmt): void => {
    switch (stmt.t) {
      case 'rem':
        return;
      case 'let':
        put(stmt.name, evalExpr(stmt.expr, get));
        return;
      case 'print': {
        const parts = stmt.args.map((arg) => asText(evalExpr(arg, get)));
        const line = parts.join('\t');
        output += `${line}\n`;
        writeText(line);
        writeChar('\n');
        return;
      }
      case 'if':
        if (truthy(evalExpr(stmt.cond, get))) exec(stmt.yes);
        else exec(stmt.no);
        return;
      case 'while':
        while (truthy(evalExpr(stmt.cond, get))) {
          try {
            exec(stmt.body);
          } catch (error) {
            if (error instanceof Flow && error.kind === 'break') break;
            if (error instanceof Flow && error.kind === 'continue') continue;
            throw error;
          }
        }
        return;
      case 'repeat':
        for (;;) {
          try {
            exec(stmt.body);
          } catch (error) {
            if (error instanceof Flow && error.kind === 'break') break;
            if (error instanceof Flow && error.kind === 'continue') continue;
            throw error;
          }
          if (truthy(evalExpr(stmt.cond, get))) break;
        }
        return;
      case 'for': {
        put(stmt.name, num(stmt.from));
        const step = num(stmt.step) || 1;
        const to = num(stmt.to);
        for (;;) {
          const i = asNumber(get(stmt.name));
          if (step > 0 ? i > to : i < to) break;
          try {
            exec(stmt.body);
          } catch (error) {
            if (error instanceof Flow && error.kind === 'break') break;
            if (error instanceof Flow && error.kind === 'continue') {
              put(stmt.name, asNumber(get(stmt.name)) + step);
              continue;
            }
            throw error;
          }
          put(stmt.name, asNumber(get(stmt.name)) + step);
        }
        return;
      }
      case 'break':
        throw new Flow('break');
      case 'continue':
        throw new Flow('continue');
      case 'return':
        throw new Flow('return', stmt.expr ? evalExpr(stmt.expr, get) : 0);
      case 'gosub': {
        const fn = fns.get(stmt.fn);
        if (!fn) throw new RetroError(`missing routine ${stmt.fn}`, 1, 1, prog.filename);
        callFn(fn, stmt.args, stmt.ret);
        return;
      }
      case 'sprite':
        return;
      case 'motion': {
        const sprite = prog.sprites.find((item) => item.id === stmt.id);
        if (!sprite) return;
        put(sprite.dx, num(stmt.dx));
        put(sprite.dy, num(stmt.dy));
        return;
      }
      case 'update':
        doUpdate();
        return;
      case 'tone':
        sounds.push({ freq: num(stmt.freq), ms: num(stmt.ms), kind: stmt.kind });
        return;
      case 'cls':
        for (const cell of cells) {
          cell.ch = ' ';
          cell.bits = null;
        }
        cursor = 0;
        return;
      case 'locate': {
        const col = Math.max(0, Math.min(cols - 1, Math.trunc(num(stmt.col))));
        const row = Math.max(0, Math.min(rows - 1, Math.trunc(num(stmt.row))));
        cursor = row * cols + col;
        return;
      }
      case 'write':
        writeText(text(stmt.text));
        output += text(stmt.text);
        return;
      case 'poke':
        return;
      default:
        return;
    }
  };

  try {
    exec(prog.main);
  } catch (error) {
    if (error instanceof Flow) {
      throw new RetroError('return, break, or continue is outside its block', 1, 1, prog.filename);
    }
    throw error;
  }

  const sprites: ScreenSprite[] = prog.sprites
    .filter((sprite) => spriteNum(sprite.alive) !== 0)
    .map((sprite) => ({
      emoji: sprite.emoji,
      x: spriteNum(sprite.x),
      y: spriteNum(sprite.y),
      size: spriteNum(sprite.size) || 8,
      bits: sprite.bits,
      color: paint(prog.target, sprite.color),
      hardware: sprite.hardware,
      label: sprite.label,
    }));

  const caption = machine.hardwareSprites
    ? `${machine.name} hardware sprites`
    : `${machine.name} has no sprite chip. Emoji are lo-res software sprites.`;

  return {
    target: prog.target,
    title: machine.name,
    cols,
    rows,
    pixelWidth: prog.width || machine.pixelWidth,
    pixelHeight: prog.height || machine.pixelHeight,
    border: paint(prog.target, machine.border),
    background: bg,
    foreground: fg,
    cells,
    sprites,
    palette: [...PALETTE[prog.target]],
    output,
    sounds,
    hardwareSprites: machine.hardwareSprites,
    caption,
  };
}
