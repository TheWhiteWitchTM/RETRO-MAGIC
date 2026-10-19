/**
 * BASIC for the three machines.
 * C64 is BASIC 2. Apple II is Applesoft. TI sprite programs are Extended BASIC.
 * `INT` floors, the way those BASICs do. Listings from the compiler wrap it
 * when they want truncation toward zero.
 * A false `IF` skips the rest of its line. `AND`, `OR`, and `NOT` are bitwise.
 */

import { RetroError } from './error.js';
import type { TargetName } from './glyph.js';

export interface BasicResult {
  output: string;
  target: TargetName;
  halted: string;
  lines: number;
  cols: number;
  rows: number;
  cells: Array<{ ch: string }>;
  sprites: Array<{ id: number; x: number; y: number; color: number; on: boolean }>;
  pixels: number[];
  sounds: Array<{ freq: number; ms: number }>;
  memory: Uint8Array;
}

interface Problem {
  line: number;
  column: number;
  message: string;
}

type Expr =
  | { k: 'n'; n: number }
  | { k: 's'; s: string }
  | { k: 'v'; name: string }
  | { k: 'u'; op: string; a: Expr }
  | { k: 'b'; op: string; a: Expr; b: Expr }
  | { k: 'f'; name: string; args: Expr[] }
  | { k: 'idx'; name: string; args: Expr[] };

type Item =
  | { kind: 'expr'; expr: Expr }
  | { kind: 'semi' }
  | { kind: 'comma' }
  | { kind: 'tab'; expr: Expr }
  | { kind: 'spc'; expr: Expr };

type Op =
  | { t: 'rem'; line: number }
  | { t: 'end'; line: number; stop: boolean }
  | { t: 'goto'; line: number; dest: Expr }
  | { t: 'gosub'; line: number; dest: Expr }
  | { t: 'return'; line: number }
  | { t: 'jump'; line: number; pc: number }
  | { t: 'if'; line: number; cond: Expr; elsePc: number }
  | { t: 'for'; line: number; name: string; from: Expr; to: Expr; step: Expr | null }
  | { t: 'next'; line: number; name: string }
  | { t: 'let'; line: number; name: string; index: Expr[] | null; expr: Expr }
  | { t: 'print'; line: number; items: Item[] }
  | { t: 'poke'; line: number; addr: Expr; value: Expr }
  | { t: 'sys'; line: number; addr: Expr }
  | { t: 'call'; line: number; name: string; args: Expr[]; numeric: boolean }
  | { t: 'cmd'; line: number; name: string; args: Expr[] }
  | { t: 'read'; line: number; names: Array<{ name: string; index: Expr[] | null }> }
  | { t: 'restore'; line: number }
  | { t: 'on'; line: number; expr: Expr; kind: 'goto' | 'gosub'; dests: number[] }
  | { t: 'data'; line: number };

const FUNCS = new Set(['INT', 'ABS', 'SGN', 'LEN', 'STR$', 'VAL', 'CHR$', 'ASC', 'PEEK', 'LEFT$', 'RIGHT$', 'MID$', 'SEG$', 'SQR', 'RND', 'FRE', 'POS', 'SIN', 'COS', 'TAN', 'ATN', 'LOG', 'EXP', 'TAB', 'SPC']);

export function runBasic(source: string, options: { target?: TargetName; filename?: string; maxSteps?: number; input?: string[] } = {}): BasicResult {
  const target = options.target ?? 'c64';
  const compiled = compileBasic(source, options.filename ?? '');
  if (compiled.problems.length) {
    const first = compiled.problems[0];
    throw new RetroError(first?.message ?? 'BASIC error', first?.line ?? 1, first?.column ?? 1, options.filename ?? '');
  }
  return execute(compiled, target, options.maxSteps ?? 1_000_000);
}

export function checkBasic(source: string, filename = ''): { ok: boolean; problems: Problem[] } {
  const compiled = compileBasic(source, filename);
  return { ok: compiled.problems.length === 0, problems: compiled.problems };
}

const C64: Record<string, number> = {
  END: 0x80, FOR: 0x81, NEXT: 0x82, DATA: 0x83, 'INPUT#': 0x84, INPUT: 0x85, DIM: 0x86, READ: 0x87, LET: 0x88,
  GOTO: 0x89, RUN: 0x8a, IF: 0x8b, RESTORE: 0x8c, GOSUB: 0x8d, RETURN: 0x8e, REM: 0x8f, STOP: 0x90, ON: 0x91,
  WAIT: 0x92, LOAD: 0x93, SAVE: 0x94, VERIFY: 0x95, DEF: 0x96, POKE: 0x97, 'PRINT#': 0x98, PRINT: 0x99, CONT: 0x9a,
  LIST: 0x9b, CLR: 0x9c, CMD: 0x9d, SYS: 0x9e, OPEN: 0x9f, CLOSE: 0xa0, GET: 0xa1, NEW: 0xa2, 'TAB(': 0xa3,
  TO: 0xa4, FN: 0xa5, 'SPC(': 0xa6, THEN: 0xa7, NOT: 0xa8, STEP: 0xa9, '+': 0xaa, '-': 0xab, '*': 0xac, '/': 0xad,
  '^': 0xae, AND: 0xaf, OR: 0xb0, '>': 0xb1, '=': 0xb2, '<': 0xb3, SGN: 0xb4, INT: 0xb5, ABS: 0xb6, USR: 0xb7,
  FRE: 0xb8, POS: 0xb9, SQR: 0xba, RND: 0xbb, LOG: 0xbc, EXP: 0xbd, COS: 0xbe, SIN: 0xbf, TAN: 0xc0, ATN: 0xc1,
  PEEK: 0xc2, LEN: 0xc3, 'STR$': 0xc4, 'VAL': 0xc5, ASC: 0xc6, 'CHR$': 0xc7, 'LEFT$': 0xc8, 'RIGHT$': 0xc9, 'MID$': 0xca, GO: 0xcb,
};

const APPLE: Record<string, number> = {
  END: 0x80, FOR: 0x81, NEXT: 0x82, DATA: 0x83, INPUT: 0x84, DEL: 0x85, DIM: 0x86, READ: 0x87, GR: 0x88, TEXT: 0x89,
  'PR#': 0x8a, 'IN#': 0x8b, CALL: 0x8c, PLOT: 0x8d, HLIN: 0x8e, VLIN: 0x8f, HGR2: 0x90, HGR: 0x91, 'HCOLOR=': 0x92,
  HPLOT: 0x93, DRAW: 0x94, XDRAW: 0x95, HTAB: 0x96, HOME: 0x97, 'ROT=': 0x98, 'SCALE=': 0x99, SHLOAD: 0x9a, TRACE: 0x9b,
  NOTRACE: 0x9c, NORMAL: 0x9d, INVERSE: 0x9e, FLASH: 0x9f, 'COLOR=': 0xa0, POP: 0xa1, VTAB: 0xa2, 'HIMEM:': 0xa3,
  'LOMEM:': 0xa4, ONERR: 0xa5, RESUME: 0xa6, RECALL: 0xa7, STORE: 0xa8, 'SPEED=': 0xa9, LET: 0xaa, GOTO: 0xab, RUN: 0xac,
  IF: 0xad, RESTORE: 0xae, '&': 0xaf, GOSUB: 0xb0, RETURN: 0xb1, REM: 0xb2, STOP: 0xb3, ON: 0xb4, WAIT: 0xb5, LOAD: 0xb6,
  SAVE: 0xb7, DEF: 0xb8, POKE: 0xb9, PRINT: 0xba, CONT: 0xbb, LIST: 0xbc, CLEAR: 0xbd, GET: 0xbe, NEW: 0xbf, 'TAB(': 0xc0,
  TO: 0xc1, FN: 0xc2, 'SPC(': 0xc3, THEN: 0xc4, AT: 0xc5, NOT: 0xc6, STEP: 0xc7, '+': 0xc8, '-': 0xc9, '*': 0xca, '/': 0xcb,
  '^': 0xcc, AND: 0xcd, OR: 0xce, '>': 0xcf, '=': 0xd0, '<': 0xd1, SGN: 0xd2, INT: 0xd3, ABS: 0xd4, USR: 0xd5, FRE: 0xd6,
  'SCRN(': 0xd7, PDL: 0xd8, POS: 0xd9, SQR: 0xda, RND: 0xdb, LOG: 0xdc, EXP: 0xdd, COS: 0xde, SIN: 0xdf, TAN: 0xe0, ATN: 0xe1,
  PEEK: 0xe2, LEN: 0xe3, 'STR$': 0xe4, VAL: 0xe5, ASC: 0xe6, 'CHR$': 0xe7, 'LEFT$': 0xe8, 'RIGHT$': 0xe9, 'MID$': 0xea,
};

const TOKEN_SORTED: Record<'c64' | 'apple2', string[]> = {
  c64: Object.keys(C64).sort((a, b) => b.length - a.length),
  apple2: Object.keys(APPLE).sort((a, b) => b.length - a.length),
};

export function tokenizeBasic(source: string, target: 'c64' | 'apple2'): Uint8Array {
  const table = target === 'c64' ? C64 : APPLE;
  const words = TOKEN_SORTED[target];
  const lines = sourceLines(source);
  let addr = 0x0801;
  const body: number[] = [];
  for (const line of lines) {
    const tokens = tokenizeLine(line.text, words, table);
    const packed = [...tokens, 0];
    const next = addr + 4 + packed.length;
    body.push(next & 255, (next >> 8) & 255, line.num & 255, (line.num >> 8) & 255, ...packed);
    addr = next;
  }
  body.push(0, 0);
  return Uint8Array.from([0x01, 0x08, ...body]);
}

export const BASIC_KEYWORDS = {
  c64: Object.keys(C64),
  apple2: Object.keys(APPLE),
  ti99: ['CALL', 'CLEAR', 'SCREEN', 'COLOR', 'CHAR', 'HCHAR', 'VCHAR', 'SOUND', 'KEY', 'SPRITE', 'MOTION', 'LOCATE', 'PATTERN', 'MAGNIFY', 'COINC', 'PRINT', 'LET', 'IF', 'THEN', 'ELSE', 'GOTO', 'GOSUB', 'RETURN', 'FOR', 'TO', 'STEP', 'NEXT', 'REM', 'END', 'STOP', 'INPUT', 'DATA', 'READ', 'RESTORE', 'DIM', 'ON', 'AND', 'OR', 'NOT', 'INT', 'ABS', 'SGN', 'LEN', 'SEG$', 'STR$', 'VAL', 'CHR$', 'ASC'],
};

function tokenizeLine(text: string, words: string[], table: Record<string, number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ') {
      out.push(0x20);
      i += 1;
      continue;
    }
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += 1;
      const end = Math.min(text.length, j + 1);
      for (let k = i; k < end; k += 1) out.push(text.charCodeAt(k) & 0xff);
      i = end;
      continue;
    }
    const slice = text.slice(i).toUpperCase();
    let matched = '';
    for (const word of words) {
      if (!slice.startsWith(word)) continue;
      const after = text[i + word.length] ?? '';
      if (/[A-Z0-9]/i.test(after) && !word.endsWith('$') && !word.endsWith('(') && !word.endsWith('=') && !word.endsWith('#') && !word.endsWith(':')) continue;
      matched = word;
      break;
    }
    if (matched) {
      out.push(table[matched] ?? 0);
      i += matched.length;
      if (matched === 'REM') {
        for (const ch of text.slice(i)) out.push(ch.charCodeAt(0) & 0xff);
        break;
      }
      continue;
    }
    out.push(text.charCodeAt(i) & 0xff);
    i += 1;
  }
  return out;
}

interface Compiled {
  ops: Op[];
  lineAt: Map<number, number>;
  data: string[];
  problems: Problem[];
  lineCount: number;
}

function compileBasic(source: string, filename: string): Compiled {
  const problems: Problem[] = [];
  const ops: Op[] = [];
  const lineAt = new Map<number, number>();
  const data: string[] = [];
  const lines = sourceLines(source);
  for (const line of lines) {
    lineAt.set(line.num, ops.length);
    try {
      const parser = new Toker(line.text, line.num);
      compileSequence(parser, ops, data, problems, 'eol');
    } catch (error) {
      if (error instanceof RetroError) problems.push({ line: error.line, column: error.column, message: error.message });
      else problems.push({ line: line.num, column: 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!lines.length) problems.push({ line: 1, column: 1, message: 'the BASIC program is empty' });
  void filename;
  return { ops, lineAt, data, problems, lineCount: lines.length };
}

function sourceLines(source: string): Array<{ num: number; text: string }> {
  const map = new Map<number, string>();
  const order: number[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s*(.*)$/.exec(raw);
    if (!match?.[1]) {
      if (raw.trim()) {
        const num = order.length ? (order[order.length - 1] ?? 0) + 1 : 10;
        map.set(num, raw.trim());
        order.push(num);
      }
      continue;
    }
    const num = Number(match[1]);
    map.set(num, match[2] ?? '');
    if (!order.includes(num)) order.push(num);
  }
  return [...map.keys()].sort((a, b) => a - b).map((num) => ({ num, text: map.get(num) ?? '' }));
}

class Toker {
  tokens: Array<{ k: string; s: string; n: number; at: number }> = [];
  i = 0;
  constructor(text: string, readonly line: number) {
    this.tokens = lex(text, line);
  }
  tok() { return this.tokens[this.i] ?? { k: 'eol', s: '', n: 0, at: 1 }; }
  eat(kind?: string, value?: string): void {
    if (kind && this.tok().k !== kind) throw new RetroError(`expected ${value ?? kind}`, this.line, this.tok().at);
    if (value && this.tok().s !== value) throw new RetroError(`expected ${value}`, this.line, this.tok().at);
    this.i += 1;
  }
  id(value?: string): boolean {
    return this.tok().k === 'id' && (value === undefined || this.tok().s === value);
  }
}

function lex(text: string, line: number): Toker['tokens'] {
  const out: Toker['tokens'] = [];
  let i = 0;
  const push = (k: string, s: string, n = 0, at = i + 1): void => {
    out.push({ k, s, n, at });
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += text[j];
        j += 1;
      }
      push('str', s, 0, i + 1);
      i = Math.min(text.length, j + 1);
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) {
      push('num', num[0], Number(num[0]), i + 1);
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z][A-Za-z0-9]*[$%]?/.exec(text.slice(i));
    if (ident) {
      const word = ident[0].toUpperCase();
      push('id', word, 0, i + 1);
      i += ident[0].length;
      if (word === 'REM') break;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      push('sym', two, 0, i + 1);
      i += 2;
      continue;
    }
    push('sym', ch, 0, i + 1);
    i += 1;
  }
  out.push({ k: 'eol', s: '', n: 0, at: text.length + 1 });
  return out;
}

function compileSequence(parser: Toker, ops: Op[], data: string[], problems: Problem[], stop: 'eol' | 'else'): void {
  while (parser.tok().k !== 'eol' && !(stop === 'else' && parser.id('ELSE'))) {
    if (parser.tok().k === 'sym' && parser.tok().s === ':') {
      parser.i += 1;
      continue;
    }
    if (parser.id('IF')) {
      compileIf(parser, ops, data, problems);
      return;
    }
    compileOne(parser, ops, data, problems);
    if (parser.tok().k === 'sym' && parser.tok().s === ':') parser.i += 1;
  }
}

function compileIf(parser: Toker, ops: Op[], data: string[], problems: Problem[]): void {
  const line = parser.line;
  parser.eat('id', 'IF');
  const cond = parseExpr(parser);
  let gotoOnly = false;
  if (parser.id('THEN')) parser.i += 1;
  else if (parser.id('GOTO')) gotoOnly = true;
  else throw new RetroError('IF needs THEN', line, parser.tok().at);
  const slot = ops.length;
  const node: Op = { t: 'if', line, cond, elsePc: 0 };
  ops.push(node);
  if (gotoOnly || parser.tok().k === 'num') {
    const dest = gotoOnly ? parseExpr(parser) : { k: 'n' as const, n: parser.tok().n };
    if (!gotoOnly) parser.i += 1;
    ops.push({ t: 'goto', line, dest });
  } else {
    compileSequence(parser, ops, data, problems, 'else');
  }
  if (parser.id('ELSE')) {
    parser.i += 1;
    const jump = ops.length;
    ops.push({ t: 'jump', line, pc: 0 });
    node.elsePc = ops.length;
    compileSequence(parser, ops, data, problems, 'eol');
    const placed = ops[jump];
    if (placed && placed.t === 'jump') placed.pc = ops.length;
  } else node.elsePc = ops.length;
}

function compileOne(parser: Toker, ops: Op[], data: string[], _problems: Problem[]): void {
  const line = parser.line;
  if (parser.tok().k === 'eol') return;
  if (parser.tok().k === 'sym' && parser.tok().s === '?') {
    parser.i += 1;
    ops.push({ t: 'print', line, items: parsePrint(parser) });
    return;
  }
  if (parser.tok().k !== 'id') throw new RetroError('expected a statement', line, parser.tok().at);
  const word = parser.tok().s;
  if (word === 'REM' || word === 'DATA') {
    if (word === 'DATA') data.push(...readData(parser));
    else parser.i = parser.tokens.length - 1;
    ops.push({ t: word === 'DATA' ? 'data' : 'rem', line });
    return;
  }
  parser.i += 1;
  if (word === 'END' || word === 'STOP' || word === 'NEW') {
    ops.push({ t: 'end', line, stop: true });
    return;
  }
  if (word === 'GOTO' || word === 'GOSUB') {
    ops.push({ t: word === 'GOTO' ? 'goto' : 'gosub', line, dest: parseExpr(parser) });
    return;
  }
  if (word === 'RETURN' || word === 'POP') {
    ops.push({ t: 'return', line });
    return;
  }
  if (word === 'PRINT' || word === 'PRINT#') {
    if (word === 'PRINT#' ) {
      parseExpr(parser);
      if (parser.tok().s === ',' || parser.tok().s === ';') parser.i += 1;
    }
    ops.push({ t: 'print', line, items: parsePrint(parser) });
    return;
  }
  if (word === 'FOR') {
    if (!parser.id()) throw new RetroError('FOR needs a variable', line, parser.tok().at);
    const name = parser.tok().s;
    parser.i += 1;
    parser.eat('sym', '=');
    const from = parseExpr(parser);
    if (!parser.id('TO')) throw new RetroError('FOR needs TO', line, parser.tok().at);
    parser.i += 1;
    const to = parseExpr(parser);
    let step: Expr | null = null;
    if (parser.id('STEP')) {
      parser.i += 1;
      step = parseExpr(parser);
    }
    ops.push({ t: 'for', line, name, from, to, step });
    return;
  }
  if (word === 'NEXT') {
    const name = parser.id() ? parser.tok().s : '';
    if (name) parser.i += 1;
    ops.push({ t: 'next', line, name });
    return;
  }
  if (word === 'POKE') {
    const addr = parseExpr(parser);
    parser.eat('sym', ',');
    ops.push({ t: 'poke', line, addr, value: parseExpr(parser) });
    return;
  }
  if (word === 'SYS' || word === 'WAIT') {
    const addr = parseExpr(parser);
    if (parser.tok().s === ',') {
      parser.i += 1;
      parseExpr(parser);
      if (parser.tok().s === ',') {
        parser.i += 1;
        parseExpr(parser);
      }
    }
    if (word === 'SYS') ops.push({ t: 'sys', line, addr });
    return;
  }
  if ((word === 'COLOR' || word === 'HCOLOR' || word === 'ROT' || word === 'SCALE' || word === 'SPEED') && parser.tok().s === '=') {
    parser.i += 1;
    ops.push({ t: 'cmd', line, name: `${word}=`, args: [parseExpr(parser)] });
    return;
  }
  if (word === 'LET') {
    ops.push(assign(parser, line));
    return;
  }
  if (word === 'READ') {
    const names: Array<{ name: string; index: Expr[] | null }> = [];
    do {
      names.push(varRef(parser));
      if (parser.tok().s === ',') parser.i += 1;
      else break;
    } while (parser.tok().k !== 'eol');
    ops.push({ t: 'read', line, names });
    return;
  }
  if (word === 'RESTORE') {
    if (parser.tok().k === 'num' || parser.tok().k === 'id') parseExpr(parser);
    ops.push({ t: 'restore', line });
    return;
  }
  if (word === 'ON') {
    const expr = parseExpr(parser);
    const kind = parser.id('GOSUB') ? 'gosub' : 'goto';
    if (!parser.id('GOTO') && !parser.id('GOSUB')) throw new RetroError('ON needs GOTO or GOSUB', line, parser.tok().at);
    parser.i += 1;
    const dests: number[] = [];
    while (parser.tok().k === 'num') {
      dests.push(parser.tok().n);
      parser.i += 1;
      if (parser.tok().s === ',') parser.i += 1;
    }
    ops.push({ t: 'on', line, expr, kind, dests });
    return;
  }
  if (word === 'DIM') {
    while (parser.id()) {
      varRef(parser);
      if (parser.tok().s === ',') parser.i += 1;
      else break;
    }
    return;
  }
  if (word === 'INPUT' || word === 'GET') {
    if (parser.tok().k === 'str') parser.i += 1;
    if (parser.tok().s === ';' || parser.tok().s === ',') parser.i += 1;
    const ref = varRef(parser);
    ops.push({ t: 'let', line, name: ref.name, index: ref.index, expr: { k: 'n', n: 0 } });
    return;
  }
  if (word === 'CALL') {
    if (parser.tok().k === 'num' || parser.tok().s === '-' || parser.tok().s === '(') {
      ops.push({ t: 'call', line, name: '', args: [parseExpr(parser)], numeric: true });
      return;
    }
    const name = parser.id() ? parser.tok().s : '';
    if (!name) throw new RetroError('CALL needs a name', line, parser.tok().at);
    parser.i += 1;
    const args: Expr[] = [];
    if (parser.tok().s === '(') {
      parser.i += 1;
      if (parser.tok().s !== ')') {
        do {
          if (parser.tok().s === '#') parser.i += 1;
          if (parser.id() && parser.tokens[parser.i + 1]?.s !== '(' && parser.tokens[parser.i + 1]?.s !== '$') {
            const ahead = parser.tokens[parser.i + 1];
            if (!ahead || ahead.s === ',' || ahead.s === ')') {
              args.push({ k: 'v', name: parser.tok().s });
              parser.i += 1;
            } else args.push(parseExpr(parser));
          } else args.push(parseExpr(parser));
          if (parser.tok().s === ',') parser.i += 1;
          else break;
        } while (parser.tok().s !== ')');
      }
      if (parser.tok().s === ')') parser.i += 1;
    }
    ops.push({ t: 'call', line, name, args, numeric: false });
    return;
  }
  if (['GR', 'TEXT', 'HOME', 'HGR', 'HGR2', 'PLOT', 'HLIN', 'VLIN', 'HTAB', 'VTAB', 'HPLOT', 'COLOR=', 'HCOLOR=', 'CLS', 'CLEAR', 'NEW', 'CLR', 'LIST', 'CONT', 'RUN', 'NORMAL', 'INVERSE', 'FLASH', 'TRACE', 'NOTRACE'].includes(word) || word.endsWith('=')) {
    const args: Expr[] = [];
    const name = word;
    if (parser.tok().s === '=') parser.i += 1;
    while (parser.tok().k !== 'eol' && parser.tok().s !== ':') {
      if (parser.id('AT') || parser.id('TO')) {
        parser.i += 1;
        continue;
      }
      if (parser.tok().k === 'id' && ['STEP', 'THEN', 'ELSE'].includes(parser.tok().s)) break;
      try {
        args.push(parseExpr(parser));
      } catch {
        break;
      }
      if (parser.tok().s === ',' || parser.tok().s === ';') parser.i += 1;
    }
    ops.push({ t: 'cmd', line, name, args });
    return;
  }
  parser.i -= 1;
  ops.push(assign(parser, line));
}

function assign(parser: Toker, line: number): Op {
  const ref = varRef(parser);
  if (parser.tok().s !== '=') throw new RetroError('expected =', line, parser.tok().at);
  parser.i += 1;
  return { t: 'let', line, name: ref.name, index: ref.index, expr: parseExpr(parser) };
}

function varRef(parser: Toker): { name: string; index: Expr[] | null } {
  if (!parser.id()) throw new RetroError('expected a variable', parser.line, parser.tok().at);
  const name = parser.tok().s;
  parser.i += 1;
  if (parser.tok().s !== '(') return { name, index: null };
  parser.i += 1;
  const index: Expr[] = [];
  if (parser.tok().s !== ')') {
    do {
      index.push(parseExpr(parser));
      if (parser.tok().s === ',') parser.i += 1;
      else break;
    } while (parser.tok().k !== 'eol');
  }
  if (parser.tok().s === ')') parser.i += 1;
  return { name, index };
}

function readData(parser: Toker): string[] {
  parser.i += 1;
  const out: string[] = [];
  while (parser.tok().k !== 'eol' && parser.tok().s !== ':') {
    if (parser.tok().k === 'str' || parser.tok().k === 'num') out.push(parser.tok().k === 'str' ? parser.tok().s : parser.tok().s);
    else if (parser.tok().s !== ',') out.push(parser.tok().s);
    parser.i += 1;
  }
  return out;
}

function parsePrint(parser: Toker): Item[] {
  const items: Item[] = [];
  while (parser.tok().k !== 'eol' && parser.tok().s !== ':' && !parser.id('ELSE')) {
    if (parser.tok().s === ';') {
      items.push({ kind: 'semi' });
      parser.i += 1;
      continue;
    }
    if (parser.tok().s === ',') {
      items.push({ kind: 'comma' });
      parser.i += 1;
      continue;
    }
    if (parser.id('TAB') || parser.id('SPC')) {
      const kind = parser.tok().s === 'TAB' ? 'tab' : 'spc';
      parser.i += 1;
      parser.eat('sym', '(');
      const expr = parseExpr(parser);
      parser.eat('sym', ')');
      items.push({ kind, expr });
      continue;
    }
    items.push({ kind: 'expr', expr: parseExpr(parser) });
  }
  return items;
}

function parseExpr(parser: Toker): Expr {
  return parseOr(parser);
}

function parseOr(parser: Toker): Expr {
  let left = parseAnd(parser);
  while (parser.id('OR')) {
    parser.i += 1;
    left = { k: 'b', op: 'OR', a: left, b: parseAnd(parser) };
  }
  return left;
}

function parseAnd(parser: Toker): Expr {
  let left = parseNot(parser);
  while (parser.id('AND')) {
    parser.i += 1;
    left = { k: 'b', op: 'AND', a: left, b: parseNot(parser) };
  }
  return left;
}

function parseNot(parser: Toker): Expr {
  if (parser.id('NOT')) {
    parser.i += 1;
    return { k: 'u', op: 'NOT', a: parseNot(parser) };
  }
  return parseCmp(parser);
}

function parseCmp(parser: Toker): Expr {
  let left = parseAdd(parser);
  while (parser.tok().k === 'sym' && ['=', '<', '>', '<=', '>=', '<>'].includes(parser.tok().s)) {
    const op = parser.tok().s;
    parser.i += 1;
    left = { k: 'b', op, a: left, b: parseAdd(parser) };
  }
  return left;
}

function parseAdd(parser: Toker): Expr {
  let left = parseMul(parser);
  while (parser.tok().s === '+' || parser.tok().s === '-' || parser.tok().s === '&') {
    const op = parser.tok().s;
    parser.i += 1;
    left = { k: 'b', op, a: left, b: parseMul(parser) };
  }
  return left;
}

function parseMul(parser: Toker): Expr {
  let left = parsePow(parser);
  while (parser.tok().s === '*' || parser.tok().s === '/') {
    const op = parser.tok().s;
    parser.i += 1;
    left = { k: 'b', op, a: left, b: parsePow(parser) };
  }
  return left;
}

function parsePow(parser: Toker): Expr {
  const left = parseUnary(parser);
  if (parser.tok().s === '^') {
    parser.i += 1;
    return { k: 'b', op: '^', a: left, b: parsePow(parser) };
  }
  return left;
}

function parseUnary(parser: Toker): Expr {
  if (parser.tok().s === '-') {
    parser.i += 1;
    return { k: 'u', op: '-', a: parseUnary(parser) };
  }
  if (parser.tok().s === '+') {
    parser.i += 1;
    return parseUnary(parser);
  }
  return parseAtom(parser);
}

function parseAtom(parser: Toker): Expr {
  const tok = parser.tok();
  if (tok.k === 'num') {
    parser.i += 1;
    return { k: 'n', n: tok.n };
  }
  if (tok.k === 'str') {
    parser.i += 1;
    return { k: 's', s: tok.s };
  }
  if (tok.s === '(') {
    parser.i += 1;
    const inner = parseExpr(parser);
    if (parser.tok().s !== ')') throw new RetroError('missing )', parser.line, parser.tok().at);
    parser.i += 1;
    return inner;
  }
  if (tok.k === 'id') {
    const name = tok.s;
    parser.i += 1;
    if (parser.tok().s === '(') {
      parser.i += 1;
      const args: Expr[] = [];
      if (parser.tok().s !== ')') {
        do {
          args.push(parseExpr(parser));
          if (parser.tok().s === ',') parser.i += 1;
          else break;
        } while (parser.tok().k !== 'eol');
      }
      if (parser.tok().s !== ')') throw new RetroError('missing )', parser.line, parser.tok().at);
      parser.i += 1;
      if (FUNCS.has(name)) return { k: 'f', name, args };
      return { k: 'idx', name, args };
    }
    return { k: 'v', name };
  }
  throw new RetroError('bad expression', parser.line, tok.at);
}

interface ForFrame {
  kind: 'for';
  name: string;
  to: number;
  step: number;
  body: number;
}
interface SubFrame {
  kind: 'sub';
  pc: number;
}

function execute(compiled: Compiled, target: TargetName, maxSteps: number): BasicResult {
  const spec = target === 'apple2' ? { cols: 40, rows: 24 } : target === 'ti99' ? { cols: 32, rows: 24 } : { cols: 40, rows: 25 };
  const vars = new Map<string, number | string>();
  const mem = new Uint8Array(65536);
  const cells = Array.from({ length: spec.cols * spec.rows }, () => ({ ch: ' ' }));
  const pixels = Array.from({ length: 40 * 48 }, () => -1);
  const tiSprites: BasicResult['sprites'] = [];
  const sounds: BasicResult['sounds'] = [];
  let output = '';
  let col = 0;
  let row = 0;
  let color = 15;
  let graphics = false;
  let dataAt = 0;
  let pc = 0;
  let steps = 0;
  let halted = 'end';
  const stack: Array<ForFrame | SubFrame> = [];
  const ops = compiled.ops;

  const fail = (op: Op, message: string): never => {
    throw new RetroError(message, op.line, 1);
  };
  const num = (value: number | string): number => (typeof value === 'number' ? value : Number(value) || 0);
  const text = (value: number | string): string => (typeof value === 'string' ? value : formatNum(value));
  const keyOf = (name: string, index: Expr[] | null): string => {
    if (!index?.length) return name;
    return `${name}(${index.map((item) => num(evalExpr(item))).join(',')})`;
  };
  const get = (name: string): number | string => vars.get(name) ?? (name.endsWith('$') ? '' : 0);
  const set = (name: string, value: number | string): void => {
    if (name.endsWith('%') && typeof value === 'number') vars.set(name, value & 0xffff);
    else vars.set(name, value);
  };
  const truth = (value: number | string): boolean => (typeof value === 'string' ? value !== '' : value !== 0);
  const poke = (addr: number, value: number): void => {
    const at = addr < 0 ? (addr + 65536) & 65535 : addr & 65535;
    mem[at] = value & 255;
  };
  const peek = (addr: number): number => {
    const at = addr < 0 ? (addr + 65536) & 65535 : addr & 65535;
    if (at === 49200 || addr === -16336) return 0;
    return mem[at] ?? 0;
  };
  const place = (ch: string): void => {
    if (ch === '\n') {
      output += '\n';
      col = 0;
      row += 1;
      if (row >= spec.rows) row = spec.rows - 1;
      return;
    }
    if (ch.charCodeAt(0) === 147) {
      for (const cell of cells) cell.ch = ' ';
      col = 0;
      row = 0;
      return;
    }
    if (ch >= ' ' && ch.charCodeAt(0) < 127) output += ch;
    else if (ch === '\t') output += '\t';
    if (row >= 0 && row < spec.rows && col >= 0 && col < spec.cols) {
      const cell = cells[row * spec.cols + col];
      if (cell && ch !== '\t') cell.ch = ch;
    }
    col += 1;
    if (col >= spec.cols) {
      col = 0;
      row += 1;
    }
  };
  const writeValue = (value: number | string): void => {
    const rendered = typeof value === 'number' ? formatNum(value, true) : value;
    for (const ch of rendered) place(ch);
  };
  const evalExpr = (expr: Expr): number | string => {
    switch (expr.k) {
      case 'n':
        return expr.n;
      case 's':
        return expr.s;
      case 'v':
        return get(expr.name);
      case 'idx':
        return get(keyOf(expr.name, expr.args));
      case 'u': {
        const value = num(evalExpr(expr.a));
        if (expr.op === '-') return -value;
        return ~Math.trunc(value);
      }
      case 'f':
        return callFn(expr.name, expr.args);
      case 'b': {
        if (expr.op === 'AND' || expr.op === 'OR') {
          const left = Math.trunc(num(evalExpr(expr.a)));
          const right = Math.trunc(num(evalExpr(expr.b)));
          return expr.op === 'AND' ? (left & right) : (left | right);
        }
        const left = evalExpr(expr.a);
        const right = evalExpr(expr.b);
        if (expr.op === '+' || expr.op === '&') {
          if (expr.op === '&' || typeof left === 'string' || typeof right === 'string') return text(left) + (typeof right === 'string' ? right : String(right));
          return num(left) + num(right);
        }
        if (expr.op === '-' || expr.op === '*' || expr.op === '/' || expr.op === '^') {
          const a = num(left);
          const b = num(right);
          if ((expr.op === '/' || expr.op === '^') && expr.op === '/' && b === 0) return 0;
          if (expr.op === '-') return a - b;
          if (expr.op === '*') return a * b;
          if (expr.op === '/') return a / b;
          return a ** b;
        }
        const same = typeof left === 'string' || typeof right === 'string' ? text(left) === (typeof right === 'string' ? right : text(right)) : num(left) === num(right);
        const order = typeof left === 'string' || typeof right === 'string' ? text(left) < (typeof right === 'string' ? right : text(right)) : num(left) < num(right);
        let ok = false;
        if (expr.op === '=') ok = same;
        else if (expr.op === '<>') ok = !same;
        else if (expr.op === '<') ok = order;
        else if (expr.op === '>') ok = !order && !same;
        else if (expr.op === '<=') ok = order || same;
        else if (expr.op === '>=') ok = !order;
        return ok ? -1 : 0;
      }
      default:
        return 0;
    }
  };
  const callFn = (name: string, args: Expr[]): number | string => {
    const values = args.map((arg) => evalExpr(arg));
    const n0 = num(values[0] ?? 0);
    const s0 = typeof values[0] === 'string' ? values[0] : String(values[0] ?? '');
    switch (name) {
      case 'INT':
        return Math.floor(n0);
      case 'ABS':
        return Math.abs(n0);
      case 'SGN':
        return n0 < 0 ? -1 : n0 > 0 ? 1 : 0;
      case 'LEN':
        return [...s0].length;
      case 'STR$':
        return formatNum(n0, true);
      case 'VAL':
        return Number(s0) || 0;
      case 'CHR$':
        return String.fromCharCode(Math.trunc(n0) & 255);
      case 'ASC':
        return s0.charCodeAt(0) || 0;
      case 'PEEK':
        return peek(n0);
      case 'SQR':
        return Math.sqrt(Math.abs(n0));
      case 'RND':
        return 0.5;
      case 'LEFT$':
        return [...s0].slice(0, num(values[1] ?? 0)).join('');
      case 'RIGHT$':
        return [...s0].slice(-Math.max(0, num(values[1] ?? 0))).join('');
      case 'MID$':
      case 'SEG$': {
        const start = Math.max(1, num(values[1] ?? 1)) - 1;
        const chars = [...s0];
        const len = values[2] === undefined ? chars.length : num(values[2]);
        return chars.slice(start, start + len).join('');
      }
      default:
        return 0;
    }
  };
  const gotoLine = (line: number, op: Op): void => {
    const dest = compiled.lineAt.get(line);
    if (dest === undefined) fail(op, `missing line ${line}`);
    else pc = dest;
  };

  while (steps < maxSteps && pc < ops.length) {
    const op = ops[pc];
    if (!op) break;
    steps += 1;
    try {
      switch (op.t) {
        case 'rem':
        case 'data':
          pc += 1;
          break;
        case 'end':
          halted = 'end';
          pc = ops.length;
          break;
        case 'jump':
          pc = op.pc;
          break;
        case 'goto':
          gotoLine(num(evalExpr(op.dest)), op);
          break;
        case 'gosub':
          stack.push({ kind: 'sub', pc: pc + 1 });
          gotoLine(num(evalExpr(op.dest)), op);
          break;
        case 'return': {
          let frame = stack.pop();
          while (frame && frame.kind !== 'sub') frame = stack.pop();
          if (frame && frame.kind === 'sub') pc = frame.pc;
          else fail(op, 'RETURN without GOSUB');
          break;
        }
        case 'if':
          pc = truth(evalExpr(op.cond)) ? pc + 1 : op.elsePc;
          break;
        case 'for': {
          set(op.name, num(evalExpr(op.from)));
          const step = op.step ? num(evalExpr(op.step)) : 1;
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            const frame = stack[i];
            if (frame?.kind === 'for' && frame.name === op.name) {
              stack.splice(i, stack.length - i);
              break;
            }
          }
          stack.push({ kind: 'for', name: op.name, to: num(evalExpr(op.to)), step: step || 1, body: pc + 1 });
          pc += 1;
          break;
        }
        case 'next': {
          let index = -1;
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            const frame = stack[i];
            if (frame?.kind === 'for' && (!op.name || frame.name === op.name)) {
              index = i;
              break;
            }
          }
          const frame = stack[index];
          if (!frame || frame.kind !== 'for') fail(op, 'NEXT without FOR');
          else {
            const value = num(get(frame.name)) + frame.step;
            set(frame.name, value);
            const more = frame.step >= 0 ? value <= frame.to : value >= frame.to;
            if (more) pc = frame.body;
            else {
              stack.splice(index, 1);
              pc += 1;
            }
          }
          break;
        }
        case 'let':
          set(keyOf(op.name, op.index), evalExpr(op.expr));
          pc += 1;
          break;
        case 'print': {
          let nl = true;
          for (const item of op.items) {
            if (item.kind === 'semi') {
              nl = false;
              continue;
            }
            if (item.kind === 'comma') {
              const pad = 10 - (col % 10);
              for (let i = 0; i < (pad === 0 ? 10 : pad); i += 1) place(' ');
              nl = false;
              continue;
            }
            if (item.kind === 'spc') {
              for (let i = 0; i < num(evalExpr(item.expr)); i += 1) place(' ');
              nl = false;
              continue;
            }
            if (item.kind === 'tab') {
              const dest = Math.max(1, num(evalExpr(item.expr))) - 1;
              while (col < dest) place(' ');
              nl = false;
              continue;
            }
            writeValue(evalExpr(item.expr));
            nl = true;
          }
          if (nl) place('\n');
          pc += 1;
          break;
        }
        case 'poke':
          poke(num(evalExpr(op.addr)), num(evalExpr(op.value)));
          pc += 1;
          break;
        case 'sys': {
          const addr = num(evalExpr(op.addr));
          if (addr === 65520) {
            col = Math.max(0, Math.min(spec.cols - 1, mem[781] ?? 0));
            row = Math.max(0, Math.min(spec.rows - 1, mem[782] ?? 0));
          }
          pc += 1;
          break;
        }
        case 'call':
          doCall(op);
          pc += 1;
          break;
        case 'cmd':
          doCmd(op);
          pc += 1;
          break;
        case 'read':
          for (const ref of op.names) {
            const raw = compiled.data[dataAt++];
            if (raw === undefined) fail(op, 'out of DATA');
            set(keyOf(ref.name, ref.index), ref.name.endsWith('$') ? raw : Number(raw) || 0);
          }
          pc += 1;
          break;
        case 'restore':
          dataAt = 0;
          pc += 1;
          break;
        case 'on': {
          const index = Math.trunc(num(evalExpr(op.expr))) - 1;
          const dest = op.dests[index];
          if (dest !== undefined) {
            if (op.kind === 'gosub') stack.push({ kind: 'sub', pc: pc + 1 });
            gotoLine(dest, op);
          } else pc += 1;
          break;
        }
        default:
          pc += 1;
      }
    } catch (error) {
      if (error instanceof RetroError) throw error;
      fail(op, error instanceof Error ? error.message : String(error));
    }
  }
  if (steps >= maxSteps) halted = 'max';

  const sprites = target === 'c64' ? c64Sprites(mem) : tiSprites.filter((sprite) => sprite.on);
  return { output, target, halted, lines: compiled.lineCount, cols: spec.cols, rows: spec.rows, cells, sprites, pixels: graphics ? pixels : [], sounds, memory: mem };

  function doCmd(op: Extract<Op, { t: 'cmd' }>): void {
    const arg = (index: number): number => num(evalExpr(op.args[index] ?? { k: 'n', n: 0 }));
    if (op.name === 'HOME' || op.name === 'CLS' || op.name === 'CLEAR') {
      for (const cell of cells) cell.ch = ' ';
      col = 0;
      row = 0;
      return;
    }
    if (op.name === 'GR') {
      graphics = true;
      return;
    }
    if (op.name === 'TEXT') {
      graphics = false;
      return;
    }
    if (op.name === 'COLOR=' || op.name === 'HCOLOR=') {
      color = arg(0) & 15;
      return;
    }
    if (op.name === 'PLOT') {
      plot(arg(0), arg(1), color);
      return;
    }
    if (op.name === 'HLIN') {
      const y = arg(2);
      for (let x = Math.min(arg(0), arg(1)); x <= Math.max(arg(0), arg(1)); x += 1) plot(x, y, color);
      return;
    }
    if (op.name === 'VLIN') {
      const x = arg(2);
      for (let y = Math.min(arg(0), arg(1)); y <= Math.max(arg(0), arg(1)); y += 1) plot(x, y, color);
      return;
    }
    if (op.name === 'HTAB') {
      col = Math.max(0, Math.min(spec.cols - 1, arg(0) - 1));
      return;
    }
    if (op.name === 'VTAB') {
      row = Math.max(0, Math.min(spec.rows - 1, arg(0) - 1));
      return;
    }
  }

  function plot(x: number, y: number, ink: number): void {
    if (x < 0 || y < 0 || x > 39 || y > 47) return;
    pixels[y * 40 + x] = ink;
  }

  function doCall(op: Extract<Op, { t: 'call' }>): void {
    if (op.numeric) return;
    const name = op.name;
    const arg = (index: number): number => num(evalExpr(op.args[index] ?? { k: 'n', n: 0 }));
    const raw = (index: number): number | string => evalExpr(op.args[index] ?? { k: 'n', n: 0 });
    if (name === 'CLEAR') {
      for (const cell of cells) cell.ch = ' ';
      col = 0;
      row = 0;
      return;
    }
    if (name === 'SCREEN' || name === 'MAGNIFY' || name === 'COLOR' || name === 'CHAR' || name === 'PATTERN') return;
    if (name === 'SOUND') {
      sounds.push({ ms: arg(0), freq: arg(1) });
      return;
    }
    if (name === 'HCHAR' || name === 'VCHAR') {
      const r = arg(0) - 1;
      const c = arg(1) - 1;
      const code = arg(2);
      const count = op.args[3] ? arg(3) : 1;
      const ch = code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
      for (let i = 0; i < count; i += 1) {
        const y = name === 'VCHAR' ? r + i : r;
        const x = name === 'HCHAR' ? c + i : c;
        if (y >= 0 && x >= 0 && y < spec.rows && x < spec.cols) {
          const cell = cells[y * spec.cols + x];
          if (cell) cell.ch = ch;
        }
      }
      return;
    }
    if (name === 'SPRITE') {
      const id = arg(0);
      if (op.args.length >= 5) {
        const row = arg(3);
        const column = arg(4);
        tiSprites[id - 1] = { id, x: column - 1, y: row - 1, color: arg(2), on: true };
      } else if (op.args.length >= 3) {
        const prev = tiSprites[id - 1] ?? { id, x: 0, y: 0, color: 1, on: true };
        prev.y = arg(1) - 1;
        prev.x = arg(2) - 1;
        prev.on = true;
        tiSprites[id - 1] = prev;
      }
      return;
    }
    if (name === 'LOCATE' || name === 'MOTION') return;
    if (name === 'LOAD') {
      poke(arg(0), arg(1));
      return;
    }
    if (name === 'KEY') {
      const varName = op.args[1]?.k === 'v' ? op.args[1].name : '';
      const status = op.args[2]?.k === 'v' ? op.args[2].name : '';
      if (varName) set(varName, 0);
      if (status) set(status, 0);
      return;
    }
    if (name === 'COINC') return;
    void raw;
    fail(op, `CALL ${name} is not on this machine`);
  }
}

function formatNum(value: number, basic = false): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value;
  const body = String(rounded);
  if (!basic) return body;
  return rounded >= 0 ? ` ${body}` : body;
}

function c64Sprites(mem: Uint8Array): BasicResult['sprites'] {
  const enable = mem[53269] ?? 0;
  const high = mem[53264] ?? 0;
  const sprites: BasicResult['sprites'] = [];
  for (let id = 0; id < 8; id += 1) {
    if ((enable & (1 << id)) === 0) continue;
    const x = (mem[53248 + id * 2] ?? 0) + ((high & (1 << id)) !== 0 ? 256 : 0) - 24;
    const y = (mem[53249 + id * 2] ?? 0) - 50;
    sprites.push({ id, x, y, color: mem[53287 + id] ?? 1, on: true });
  }
  return sprites;
}
