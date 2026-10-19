/**
 * 6502 assembler and CPU. Both read the same opcode table.
 * Documented NMOS opcodes only. JMP ($xxFF) wraps inside the page.
 * JSR $FFD2 and JSR $FDED print the accumulator and return.
 */

import { RetroError } from './error.js';
import { evalExpr, parseProgram, registerMnemonics, splitArgs, type AsmImage, type CpuResult } from './asm-expr.js';

export type { AsmImage, CpuResult } from './asm-expr.js';

type Mode = 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'absx' | 'absy' | 'ind' | 'indx' | 'indy' | 'rel';

const SIZE: Record<Mode, number> = {
  imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, rel: 2, abs: 3, absx: 3, absy: 3, ind: 3, indx: 2, indy: 2,
};

/** Documented NMOS 6502 opcodes. */
export const OPS: Record<string, Partial<Record<Mode, number>>> = {
  ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, absx: 0x7d, absy: 0x79, indx: 0x61, indy: 0x71 },
  AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, absx: 0x3d, absy: 0x39, indx: 0x21, indy: 0x31 },
  ASL: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, absx: 0x1e },
  BCC: { rel: 0x90 },
  BCS: { rel: 0xb0 },
  BEQ: { rel: 0xf0 },
  BIT: { zp: 0x24, abs: 0x2c },
  BMI: { rel: 0x30 },
  BNE: { rel: 0xd0 },
  BPL: { rel: 0x10 },
  BRK: { imp: 0x00 },
  BVC: { rel: 0x50 },
  BVS: { rel: 0x70 },
  CLC: { imp: 0x18 },
  CLD: { imp: 0xd8 },
  CLI: { imp: 0x58 },
  CLV: { imp: 0xb8 },
  CMP: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, absx: 0xdd, absy: 0xd9, indx: 0xc1, indy: 0xd1 },
  CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  DEC: { zp: 0xc6, zpx: 0xd6, abs: 0xce, absx: 0xde },
  DEX: { imp: 0xca },
  DEY: { imp: 0x88 },
  EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, absx: 0x5d, absy: 0x59, indx: 0x41, indy: 0x51 },
  INC: { zp: 0xe6, zpx: 0xf6, abs: 0xee, absx: 0xfe },
  INX: { imp: 0xe8 },
  INY: { imp: 0xc8 },
  JMP: { abs: 0x4c, ind: 0x6c },
  JSR: { abs: 0x20 },
  LDA: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, absx: 0xbd, absy: 0xb9, indx: 0xa1, indy: 0xb1 },
  LDX: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, absy: 0xbe },
  LDY: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, absx: 0xbc },
  LSR: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, absx: 0x5e },
  NOP: { imp: 0xea },
  ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, indx: 0x01, indy: 0x11 },
  PHA: { imp: 0x48 },
  PHP: { imp: 0x08 },
  PLA: { imp: 0x68 },
  PLP: { imp: 0x28 },
  ROL: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, absx: 0x3e },
  ROR: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, absx: 0x7e },
  RTI: { imp: 0x40 },
  RTS: { imp: 0x60 },
  SBC: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, absx: 0xfd, absy: 0xf9, indx: 0xe1, indy: 0xf1 },
  SEC: { imp: 0x38 },
  SED: { imp: 0xf8 },
  SEI: { imp: 0x78 },
  STA: { zp: 0x85, zpx: 0x95, abs: 0x8d, absx: 0x9d, absy: 0x99, indx: 0x81, indy: 0x91 },
  STX: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  STY: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  TAX: { imp: 0xaa },
  TAY: { imp: 0xa8 },
  TSX: { imp: 0xba },
  TXA: { imp: 0x8a },
  TXS: { imp: 0x9a },
  TYA: { imp: 0x98 },
};

const BY_OPCODE = new Map<number, { op: string; mode: Mode }>();
for (const [op, modes] of Object.entries(OPS)) {
  for (const [mode, byte] of Object.entries(modes) as Array<[Mode, number]>) {
    if (BY_OPCODE.has(byte)) throw new Error(`duplicate 6502 opcode ${byte.toString(16)}`);
    BY_OPCODE.set(byte, { op, mode });
  }
}
registerMnemonics(Object.keys(OPS));

const N = 0x80;
const V = 0x40;
const Z = 0x02;
const C = 0x01;

export function assemble6502(source: string, options: { org?: number; target?: 'c64' | 'apple2' | 'ti99' } = {}): AsmImage {
  const lines = parseProgram(source);
  const symbols = new Map<string, number>();
  let org = options.org ?? (options.target === 'apple2' ? 0x6000 : 0x0900);
  const layout: Array<{ line: number; pc: number; size: number; row: ReturnType<typeof parseProgram>[number] }> = [];
  let pc = org;
  let seenOrg = false;
  for (const row of lines) {
    if (row.op === 'ORG' || row.op === 'AORG' || row.op === '*') {
      pc = evalKnown(row.args, pc, symbols, row.line) & 0xffff;
      if (!seenOrg) {
        org = pc;
        seenOrg = true;
      }
      if (row.label) symbols.set(row.label.toUpperCase(), pc);
      continue;
    }
    if (row.label) symbols.set(row.label.toUpperCase(), pc);
    if (!row.op || row.op === 'EQU') continue;
    const size = directiveSize(row.op, row.args, row.line) ?? instructionSize(row.op, row.args);
    layout.push({ line: row.line, pc, size, row });
    pc += size;
  }
  for (const row of lines) {
    if (row.op === 'EQU' && row.label) symbols.set(row.label.toUpperCase(), evalKnown(row.args, symbols.get(row.label.toUpperCase()) ?? org, symbols, row.line) & 0xffff);
  }
  const end = pc;
  const bytes = new Uint8Array(Math.max(0, end - org));
  pc = org;
  for (const item of layout) {
    const emitted = emitLine(item.row, item.pc, symbols);
    if (emitted.length !== item.size) {
      throw new RetroError(`phase error at ${item.row.op}: ${item.size} then ${emitted.length}`, item.line, 1);
    }
    bytes.set(emitted, item.pc - org);
    pc = item.pc + emitted.length;
  }
  const target = options.target ?? (org === 0x6000 ? 'apple2' : org === 0x0900 ? 'c64' : undefined);
  const format = target === 'apple2' ? 'apple' : target === 'c64' ? 'prg' : 'bin';
  const syms: Record<string, number> = {};
  for (const [key, value] of symbols) syms[key] = value;
  return { cpu: '6502', org, bytes, symbols: syms, entry: org, image: wrapImage(bytes, org, format), format };
}

function evalKnown(text: string, pc: number, symbols: Map<string, number>, line: number): number {
  return evalExpr(text, pc, symbols, line, '6502');
}

function directiveSize(op: string, args: string, line: number): number | null {
  if (op === 'BYTE' || op === 'DB') return dataBytes(args, line).length;
  if (op === 'WORD' || op === 'DW' || op === 'DATA') return splitArgs(args).length * 2;
  if (op === 'TEXT') return textBytes(args, line).length;
  if (op === 'RES' || op === 'BSS') {
    const [count] = splitArgs(args);
    return Math.max(0, Number(count?.replace(/^\$/, '0x') ?? 0) || evalLoose(count ?? '0'));
  }
  if (op === 'ALIGN' || op === 'EVEN') return 0;
  if (op === 'END' || op === 'EQU') return 0;
  return null;
}

function evalLoose(text: string): number {
  const raw = text.trim();
  if (raw.startsWith('$')) return parseInt(raw.slice(1), 16) || 0;
  if (raw.startsWith('0x')) return parseInt(raw.slice(2), 16) || 0;
  return parseInt(raw, 10) || 0;
}

function instructionSize(op: string, args: string): number {
  const modes = OPS[op];
  if (!modes) throw new RetroError(`unknown 6502 instruction ${op}`, 1, 1);
  const mode = chooseMode(op, args, modes);
  return SIZE[mode];
}

function chooseMode(op: string, args: string, modes: Partial<Record<Mode, number>>): Mode {
  const text = args.trim();
  if (modes.rel) return 'rel';
  if (!text) {
    if (modes.imp !== undefined) return 'imp';
    if (modes.acc !== undefined) return 'acc';
    throw new RetroError(`${op} needs an operand`, 1, 1);
  }
  if (/^A$/i.test(text) && modes.acc) return 'acc';
  if (text.startsWith('#')) {
    if (!modes.imm) throw new RetroError(`${op} has no immediate form`, 1, 1);
    return 'imm';
  }
  const indy = /^\((.+)\),\s*Y$/i.exec(text);
  if (indy) return 'indy';
  const indx = /^\((.+),\s*X\)$/i.exec(text);
  if (indx) return 'indx';
  const ind = /^\((.+)\)$/.exec(text);
  if (ind) {
    if (!modes.ind) throw new RetroError(`${op} has no indirect form`, 1, 1);
    return 'ind';
  }
  const absx = /^(.+),\s*X$/i.exec(text);
  if (absx) return literalZp(absx[1] ?? '', modes.zpx) ? 'zpx' : 'absx';
  const absy = /^(.+),\s*Y$/i.exec(text);
  if (absy) return literalZp(absy[1] ?? '', modes.zpy) ? 'zpy' : 'absy';
  return literalZp(text, modes.zp) ? 'zp' : 'abs';
}

function literalZp(text: string, has: number | undefined): boolean {
  if (has === undefined) return false;
  const raw = text.trim();
  if (!/^[$#0-9%]/.test(raw) || /[A-Za-z_]/.test(raw.replace(/^0x/i, ''))) return false;
  const value = evalLoose(raw.startsWith('#') ? raw.slice(1) : raw);
  return value >= 0 && value < 256;
}

function emitLine(row: { op: string; args: string; line: number }, pc: number, symbols: Map<string, number>): number[] {
  const { op, args, line } = row;
  if (op === 'BYTE' || op === 'DB') return dataBytes(args, line, pc, symbols);
  if (op === 'TEXT') return textBytes(args, line);
  if (op === 'WORD' || op === 'DW' || op === 'DATA') {
    const out: number[] = [];
    for (const part of splitArgs(args)) {
      const value = evalExpr(part, pc, symbols, line, '6502') & 0xffff;
      out.push(value & 0xff, (value >> 8) & 0xff);
    }
    return out;
  }
  if (op === 'RES' || op === 'BSS') {
    const [countText, fillText] = splitArgs(args);
    const count = evalExpr(countText ?? '0', pc, symbols, line, '6502');
    const fill = fillText ? evalExpr(fillText, pc, symbols, line, '6502') & 0xff : 0;
    return Array.from({ length: Math.max(0, count) }, () => fill);
  }
  if (op === 'ALIGN' || op === 'EVEN' || op === 'END' || op === 'EQU') return [];
  const modes = OPS[op];
  if (!modes) throw new RetroError(`unknown 6502 instruction ${op}`, line, 1);
  const mode = chooseMode(op, args, modes);
  const opcode = modes[mode];
  if (opcode === undefined) throw new RetroError(`${op} has no ${mode} form`, line, 1);
  if (mode === 'imp' || mode === 'acc') return [opcode];
  if (mode === 'rel') {
    const target = evalExpr(args, pc, symbols, line, '6502') & 0xffff;
    let disp = target - (pc + 2);
    if (disp > 127 || disp < -128) throw new RetroError(`branch to ${args} is out of range`, line, 1);
    if (disp < 0) disp += 256;
    return [opcode, disp & 0xff];
  }
  const expr = operandExpr(args, mode);
  const value = evalExpr(expr, pc, symbols, line, '6502');
  if (mode === 'imm' || mode === 'zp' || mode === 'zpx' || mode === 'zpy' || mode === 'indx' || mode === 'indy') {
    return [opcode, value & 0xff];
  }
  const word = value & 0xffff;
  return [opcode, word & 0xff, (word >> 8) & 0xff];
}

function operandExpr(args: string, mode: Mode): string {
  const text = args.trim();
  if (mode === 'imm') return text.replace(/^#/, '');
  const indy = /^\((.+)\),\s*Y$/i.exec(text);
  if (indy?.[1]) return indy[1];
  const indx = /^\((.+),\s*X\)$/i.exec(text);
  if (indx?.[1]) return indx[1];
  const ind = /^\((.+)\)$/.exec(text);
  if (ind?.[1]) return ind[1];
  const xy = /^(.+),\s*[XY]$/i.exec(text);
  if (xy?.[1]) return xy[1];
  return text;
}

function dataBytes(args: string, line: number, pc = 0, symbols?: Map<string, number>): number[] {
  const out: number[] = [];
  for (const part of splitArgs(args)) {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'") && part.length !== 3)) {
      for (const ch of part.slice(1, -1)) out.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const value = symbols ? evalExpr(part, pc, symbols, line, '6502') : evalLoose(part);
    out.push(value & 0xff);
  }
  return out;
}

function textBytes(args: string, line: number): number[] {
  const parts = splitArgs(args);
  const out: number[] = [];
  for (const part of parts) {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      for (const ch of part.slice(1, -1)) out.push(ch.charCodeAt(0) & 0xff);
    } else throw new RetroError('TEXT needs a string', line, 1);
  }
  return out;
}

function wrapImage(code: Uint8Array, org: number, format: AsmImage['format']): Uint8Array {
  if (format === 'apple') {
    const file = new Uint8Array(4 + code.length);
    file[0] = org & 0xff;
    file[1] = (org >> 8) & 0xff;
    file[2] = code.length & 0xff;
    file[3] = (code.length >> 8) & 0xff;
    file.set(code, 4);
    return file;
  }
  if (format === 'prg' && org >= 0x0801) {
    const digits = ` ${org}`;
    const body = [0x9e, ...[...digits].map((ch) => ch.charCodeAt(0)), 0];
    const lineLen = 4 + body.length;
    const start = 0x0801;
    const end = org + code.length;
    const mem = new Uint8Array(Math.max(lineLen + 2, end - start));
    const next = start + lineLen;
    mem[0] = next & 0xff;
    mem[1] = (next >> 8) & 0xff;
    mem[2] = 10;
    mem[3] = 0;
    mem.set(body, 4);
    mem.set(code, org - start);
    const file = new Uint8Array(2 + mem.length);
    file[0] = 0x01;
    file[1] = 0x08;
    file.set(mem, 2);
    return file;
  }
  return code;
}

export function run6502(program: string | AsmImage, options: { maxCycles?: number; target?: 'c64' | 'apple2' | 'ti99'; org?: number } = {}): CpuResult {
  const image = typeof program === 'string' ? assemble6502(program, options) : program;
  return run6502Image(image, options.maxCycles ?? 2_000_000);
}

export function run6502Image(image: AsmImage, maxCycles = 2_000_000): CpuResult {
  const mem = new Uint8Array(65536);
  mem.set(image.bytes, image.org);
  let a = 0;
  let x = 0;
  let y = 0;
  let sp = 0xff;
  let p = 0x20;
  let pc = image.entry & 0xffff;
  let cycles = 0;
  let output = '';
  let halted = 'max';
  const push = (value: number): void => {
    mem[0x100 + sp] = value & 0xff;
    sp = (sp - 1) & 0xff;
  };
  const pull = (): number => {
    sp = (sp + 1) & 0xff;
    return mem[0x100 + sp] ?? 0;
  };
  const setNZ = (value: number): void => {
    const byte = value & 0xff;
    p = (p & ~(N | Z)) | (byte & N) | (byte === 0 ? Z : 0);
  };
  const read = (addr: number): number => mem[addr & 0xffff] ?? 0;
  const write = (addr: number, value: number): void => {
    mem[addr & 0xffff] = value & 0xff;
  };

  while (cycles < maxCycles) {
    const at = pc & 0xffff;
    const opcode = read(at);
    const def = BY_OPCODE.get(opcode);
    if (!def) {
      halted = `illegal $${opcode.toString(16)}`;
      break;
    }
    if (def.op === 'BRK') {
      halted = 'brk';
      break;
    }
    cycles += 2;
    if (def.op === 'JSR') {
      const target = read(at + 1) | (read(at + 2) << 8);
      if (target === 0xffd2 || target === 0xfded) {
        const ch = a & 0xff;
        output += ch === 13 || ch === 10 ? '\n' : ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '';
        pc = (at + 3) & 0xffff;
        continue;
      }
      const ret = (at + 2) & 0xffff;
      push((ret >> 8) & 0xff);
      push(ret & 0xff);
      pc = target;
      continue;
    }
    const mode = def.mode;
    let addr = 0;
    let value = 0;
    if (mode === 'imm') value = read(at + 1);
    else if (mode === 'zp') addr = read(at + 1);
    else if (mode === 'zpx') addr = (read(at + 1) + x) & 0xff;
    else if (mode === 'zpy') addr = (read(at + 1) + y) & 0xff;
    else if (mode === 'abs') addr = read(at + 1) | (read(at + 2) << 8);
    else if (mode === 'absx') addr = ((read(at + 1) | (read(at + 2) << 8)) + x) & 0xffff;
    else if (mode === 'absy') addr = ((read(at + 1) | (read(at + 2) << 8)) + y) & 0xffff;
    else if (mode === 'ind') {
      const ptr = read(at + 1) | (read(at + 2) << 8);
      const lo = read(ptr);
      const hi = read((ptr & 0xff00) | ((ptr + 1) & 0xff));
      addr = lo | (hi << 8);
    } else if (mode === 'indx') {
      const base = (read(at + 1) + x) & 0xff;
      addr = read(base) | (read((base + 1) & 0xff) << 8);
    } else if (mode === 'indy') {
      const base = read(at + 1);
      addr = ((read(base) | (read((base + 1) & 0xff) << 8)) + y) & 0xffff;
    }
    if (mode !== 'imm' && mode !== 'acc' && mode !== 'imp' && mode !== 'rel') value = read(addr);
    const length = SIZE[mode];
    let branched = false;
    const next = (at + length) & 0xffff;
    const store = (result: number): void => {
      if (mode === 'acc') a = result & 0xff;
      else write(addr, result);
    };
    switch (def.op) {
      case 'LDA':
        a = value & 0xff;
        setNZ(a);
        break;
      case 'LDX':
        x = value & 0xff;
        setNZ(x);
        break;
      case 'LDY':
        y = value & 0xff;
        setNZ(y);
        break;
      case 'STA':
        write(addr, a);
        break;
      case 'STX':
        write(addr, x);
        break;
      case 'STY':
        write(addr, y);
        break;
      case 'TAX':
        x = a;
        setNZ(x);
        break;
      case 'TAY':
        y = a;
        setNZ(y);
        break;
      case 'TXA':
        a = x;
        setNZ(a);
        break;
      case 'TYA':
        a = y;
        setNZ(a);
        break;
      case 'TSX':
        x = sp;
        setNZ(x);
        break;
      case 'TXS':
        sp = x & 0xff;
        break;
      case 'PHA':
        push(a);
        break;
      case 'PHP':
        push(p | 0x30);
        break;
      case 'PLA':
        a = pull();
        setNZ(a);
        break;
      case 'PLP':
        p = (pull() | 0x20) & ~0x10;
        break;
      case 'AND':
        a &= value;
        setNZ(a);
        break;
      case 'ORA':
        a |= value;
        setNZ(a);
        break;
      case 'EOR':
        a ^= value;
        setNZ(a);
        break;
      case 'BIT':
        p = (p & ~(N | V | Z)) | (value & (N | V)) | ((a & value) === 0 ? Z : 0);
        break;
      case 'ADC': {
        const r = add6502(a, value, (p & C) !== 0, (p & 0x08) !== 0);
        a = r.result;
        p = (p & ~(C | V)) | (r.carry ? C : 0) | (r.overflow ? V : 0);
        setNZ(a);
        break;
      }
      case 'SBC': {
        const r = add6502(a, value ^ 0xff, (p & C) !== 0, (p & 0x08) !== 0);
        a = r.result;
        p = (p & ~(C | V)) | (r.carry ? C : 0) | (r.overflow ? V : 0);
        setNZ(a);
        break;
      }
      case 'CMP':
        compare(a, value);
        break;
      case 'CPX':
        compare(x, value);
        break;
      case 'CPY':
        compare(y, value);
        break;
      case 'INC': {
        const result = (value + 1) & 0xff;
        store(result);
        setNZ(result);
        break;
      }
      case 'DEC': {
        const result = (value - 1) & 0xff;
        store(result);
        setNZ(result);
        break;
      }
      case 'INX':
        x = (x + 1) & 0xff;
        setNZ(x);
        break;
      case 'DEX':
        x = (x - 1) & 0xff;
        setNZ(x);
        break;
      case 'INY':
        y = (y + 1) & 0xff;
        setNZ(y);
        break;
      case 'DEY':
        y = (y - 1) & 0xff;
        setNZ(y);
        break;
      case 'ASL': {
        p = (p & ~C) | ((value & 0x80) !== 0 ? C : 0);
        const result = (value << 1) & 0xff;
        store(result);
        setNZ(result);
        break;
      }
      case 'LSR': {
        p = (p & ~C) | ((value & 0x01) !== 0 ? C : 0);
        const result = (value >> 1) & 0xff;
        store(result);
        setNZ(result);
        break;
      }
      case 'ROL': {
        const carry = (p & C) !== 0 ? 1 : 0;
        p = (p & ~C) | ((value & 0x80) !== 0 ? C : 0);
        const result = ((value << 1) | carry) & 0xff;
        store(result);
        setNZ(result);
        break;
      }
      case 'ROR': {
        const carry = (p & C) !== 0 ? 0x80 : 0;
        p = (p & ~C) | ((value & 0x01) !== 0 ? C : 0);
        const result = ((value >> 1) | carry) & 0xff;
        store(result);
        setNZ(result);
        break;
      }
      case 'JMP':
        if (addr === at) {
          halted = 'jmp';
          pc = addr;
          cycles += 1;
          break;
        }
        pc = addr;
        branched = true;
        break;
      case 'RTS': {
        const lo = pull();
        const hi = pull();
        pc = ((hi << 8) | lo) + 1;
        branched = true;
        break;
      }
      case 'RTI': {
        p = (pull() | 0x20) & ~0x10;
        const lo = pull();
        const hi = pull();
        pc = (hi << 8) | lo;
        branched = true;
        break;
      }
      case 'BCC':
      case 'BCS':
      case 'BEQ':
      case 'BMI':
      case 'BNE':
      case 'BPL':
      case 'BVC':
      case 'BVS': {
        const disp = read(at + 1) << 24 >> 24;
        const target = (at + 2 + disp) & 0xffff;
        const take =
          (def.op === 'BCC' && (p & C) === 0) ||
          (def.op === 'BCS' && (p & C) !== 0) ||
          (def.op === 'BEQ' && (p & Z) !== 0) ||
          (def.op === 'BNE' && (p & Z) === 0) ||
          (def.op === 'BMI' && (p & N) !== 0) ||
          (def.op === 'BPL' && (p & N) === 0) ||
          (def.op === 'BVC' && (p & V) === 0) ||
          (def.op === 'BVS' && (p & V) !== 0);
        if (take) {
          if (target === at) {
            halted = 'jmp';
            pc = target;
          } else pc = target;
          branched = true;
        }
        break;
      }
      case 'CLC':
        p &= ~C;
        break;
      case 'SEC':
        p |= C;
        break;
      case 'CLI':
        p &= ~0x04;
        break;
      case 'SEI':
        p |= 0x04;
        break;
      case 'CLD':
        p &= ~0x08;
        break;
      case 'SED':
        p |= 0x08;
        break;
      case 'CLV':
        p &= ~V;
        break;
      case 'NOP':
        break;
      default:
        halted = `unimplemented ${def.op}`;
        break;
    }
    if (halted !== 'max') break;
    if (!branched) pc = next;
    if ((def.op === 'JMP' || def.op === 'BCC' || def.op === 'BCS' || def.op === 'BEQ' || def.op === 'BMI' || def.op === 'BNE' || def.op === 'BPL' || def.op === 'BVC' || def.op === 'BVS') && pc === at && halted === 'max') {
      halted = 'jmp';
      break;
    }
  }
  return { output, cycles, halted, pc: pc & 0xffff, memory: mem, a, x, y };

  function compare(left: number, right: number): void {
    const diff = (left - right) & 0xff;
    p = (p & ~(N | Z | C)) | (diff & N) | (diff === 0 ? Z : 0) | (left >= right ? C : 0);
  }
}

function add6502(left: number, right: number, carry: boolean, decimal: boolean): { result: number; carry: boolean; overflow: boolean } {
  if (!decimal) {
    const sum = left + right + (carry ? 1 : 0);
    const result = sum & 0xff;
    return { result, carry: sum > 0xff, overflow: (~(left ^ right) & (left ^ result) & 0x80) !== 0 };
  }
  let lo = (left & 0x0f) + (right & 0x0f) + (carry ? 1 : 0);
  if (lo > 9) lo += 6;
  let hi = (left >> 4) + (right >> 4) + (lo > 15 ? 1 : 0);
  if (hi > 9) hi += 6;
  const result = ((hi & 0x0f) << 4) | (lo & 0x0f);
  return { result, carry: hi > 15, overflow: (~(left ^ right) & (left ^ result) & 0x80) !== 0 };
}
