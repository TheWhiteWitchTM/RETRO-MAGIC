/**
 * TMS9900 assembler and CPU. Both use these encodings.
 * Workspace registers live at WP. Byte ops on a register use its high byte.
 * A write to >8C00 is a VDP data byte and becomes console output.
 * JMP to the same address stops the runner. BLWP and RTWP save the context.
 */

import { RetroError } from './error.js';
import { evalExpr, parseProgram, registerMnemonics, splitArgs, type AsmImage, type CpuResult } from './asm-expr.js';

export type { AsmImage, CpuResult } from './asm-expr.js';

export const DUALS: Record<string, { base: number; byte: boolean }> = {
  SZC: { base: 0x4000, byte: false },
  SZCB: { base: 0x5000, byte: true },
  S: { base: 0x6000, byte: false },
  SB: { base: 0x7000, byte: true },
  C: { base: 0x8000, byte: false },
  CB: { base: 0x9000, byte: true },
  A: { base: 0xa000, byte: false },
  AB: { base: 0xb000, byte: true },
  MOV: { base: 0xc000, byte: false },
  MOVB: { base: 0xd000, byte: true },
  SOC: { base: 0xe000, byte: false },
  SOCB: { base: 0xf000, byte: true },
  MPY: { base: 0x3800, byte: false },
  DIV: { base: 0x3c00, byte: false },
};

export const JUMPS: Record<string, number> = {
  JMP: 0x1000,
  JLT: 0x1100,
  JLE: 0x1200,
  JEQ: 0x1300,
  JHE: 0x1400,
  JGT: 0x1500,
  JNE: 0x1600,
  JNC: 0x1700,
  JOC: 0x1800,
  JNO: 0x1900,
  JL: 0x1a00,
  JH: 0x1b00,
  JOP: 0x1c00,
  SBO: 0x1d00,
  SBZ: 0x1e00,
  TB: 0x1f00,
};

export const SINGLES: Record<string, number> = {
  BLWP: 0x0400,
  B: 0x0440,
  X: 0x0480,
  CLR: 0x04c0,
  NEG: 0x0500,
  INV: 0x0540,
  INC: 0x0580,
  INCT: 0x05c0,
  DEC: 0x0600,
  DECT: 0x0640,
  BL: 0x0680,
  SWPB: 0x06c0,
  SETO: 0x0700,
  ABS: 0x0740,
};

export const SHIFTS: Record<string, number> = { SRA: 0x0800, SRL: 0x0900, SLA: 0x0a00, SRC: 0x0b00 };
export const IMM: Record<string, number> = { LI: 0x0200, AI: 0x0220, ANDI: 0x0240, ORI: 0x0260, CI: 0x0280 };
export const FIXED: Record<string, number> = {
  STWP: 0x02a0,
  STST: 0x02c0,
  LWPI: 0x02e0,
  LIMI: 0x0300,
  IDLE: 0x0340,
  RSET: 0x0360,
  RTWP: 0x0380,
  CKON: 0x03a0,
  CKOF: 0x03c0,
  LREX: 0x03e0,
};

registerMnemonics([...Object.keys(DUALS), ...Object.keys(JUMPS), ...Object.keys(SINGLES), ...Object.keys(SHIFTS), ...Object.keys(IMM), ...Object.keys(FIXED), 'RT', 'NOP']);

interface GA {
  t: number;
  r: number;
  extra?: string;
}

export function assemble9900(source: string, options: { org?: number } = {}): AsmImage {
  const lines = parseProgram(source);
  const symbols = new Map<string, number>();
  let org = options.org ?? 0xa000;
  let pc = org;
  let seen = false;
  const layout: Array<{ pc: number; size: number; row: ReturnType<typeof parseProgram>[number] }> = [];
  for (const row of lines) {
    if (row.op === 'END') break;
    if (row.op === 'ORG' || row.op === 'AORG') {
      pc = evalExpr(row.args, pc, symbols, row.line, '9900') & 0xffff;
      if (!seen) {
        org = pc;
        seen = true;
      }
      if (row.label) symbols.set(row.label.toUpperCase(), pc);
      continue;
    }
    if (row.op === 'EQU') {
      if (row.label) symbols.set(row.label.toUpperCase(), evalExpr(row.args, pc, symbols, row.line, '9900') & 0xffff);
      continue;
    }
    if (row.label) symbols.set(row.label.toUpperCase(), pc);
    if (!row.op) continue;
    if (row.op === 'EVEN' || row.op === 'ALIGN') {
      const align = row.op === 'EVEN' ? 2 : evalExpr(row.args || '2', pc, symbols, row.line, '9900');
      const pad = (align - (pc % align)) % align;
      if (pad) layout.push({ pc, size: pad, row });
      pc += pad;
      continue;
    }
    const size = sizeOf(row.op, row.args, row.line);
    if ((pc & 1) && size >= 2 && row.op !== 'BYTE' && row.op !== 'DB' && row.op !== 'TEXT' && row.op !== 'RES' && row.op !== 'BSS') {
      throw new RetroError(`${row.op} is on an odd address. Use EVEN.`, row.line, 1);
    }
    layout.push({ pc, size, row });
    pc += size;
  }
  const bytes = new Uint8Array(Math.max(0, pc - org));
  for (const item of layout) {
    const emitted = item.row.op === 'EVEN' || item.row.op === 'ALIGN'
      ? Array.from({ length: item.size }, () => 0)
      : emit(item.row, item.pc, symbols);
    if (emitted.length !== item.size) throw new RetroError(`phase error at ${item.row.op}`, item.row.line, 1);
    bytes.set(emitted, item.pc - org);
  }
  const syms: Record<string, number> = {};
  for (const [key, value] of symbols) syms[key] = value;
  return { cpu: '9900', org, bytes, symbols: syms, entry: org, image: bytes, format: 'bin' };
}

function sizeOf(op: string, args: string, line: number): number {
  if (op === 'BYTE' || op === 'DB' || op === 'TEXT') return rawBytes(op, args, line).length;
  if (op === 'WORD' || op === 'DW' || op === 'DATA') return splitArgs(args).filter(Boolean).length * 2;
  if (op === 'RES' || op === 'BSS') return Math.max(0, Number(splitArgs(args)[0] ?? 0) || 0);
  if (op === 'RT') return 2;
  if (op === 'NOP') return 2;
  if (DUALS[op]) {
    const [src, dest] = operands(args, line);
    return 2 + (src && src.t === 2 ? 2 : 0) + (dest && dest.t === 2 ? 2 : 0);
  }
  if (JUMPS[op] !== undefined) return 2;
  if (SINGLES[op]) return 2 + (parseGA(args, line).t === 2 ? 2 : 0);
  if (SHIFTS[op]) return 2;
  if (IMM[op] || op === 'LWPI' || op === 'LIMI') return 4;
  if (FIXED[op]) return op === 'LWPI' || op === 'LIMI' ? 4 : 2;
  throw new RetroError(`unknown TMS9900 instruction ${op}`, line, 1);
}

function emit(row: { op: string; args: string; line: number }, pc: number, symbols: Map<string, number>): number[] {
  const { op, args, line } = row;
  if (op === 'BYTE' || op === 'DB' || op === 'TEXT') return rawBytes(op, args, line, pc, symbols);
  if (op === 'WORD' || op === 'DW' || op === 'DATA') {
    const out: number[] = [];
    for (const part of splitArgs(args)) {
      const value = evalExpr(part, pc, symbols, line, '9900') & 0xffff;
      out.push((value >> 8) & 0xff, value & 0xff);
    }
    return out;
  }
  if (op === 'RES' || op === 'BSS') {
    const [countText, fillText] = splitArgs(args);
    const count = evalExpr(countText ?? '0', pc, symbols, line, '9900');
    const fill = fillText ? evalExpr(fillText, pc, symbols, line, '9900') & 0xff : 0;
    return Array.from({ length: Math.max(0, count) }, () => fill);
  }
  if (op === 'RT') return emit(pseudo('B', '*R11', line), pc, symbols);
  if (op === 'NOP') return [(JUMPS.JMP ?? 0x1000) >> 8, 0];
  if (DUALS[op]) {
    const [src, dest] = operands(args, line);
    if (!src || !dest) throw new RetroError(`${op} needs two operands`, line, 1);
    const spec = DUALS[op];
    if (!spec) throw new RetroError(op, line, 1);
    const word = (spec.base | ((dest.t & 3) << 10) | ((dest.r & 15) << 6) | ((src.t & 3) << 4) | (src.r & 15)) & 0xffff;
    const out = wordBytes(word);
    if (src.extra !== undefined) out.push(...wordBytes(evalExpr(src.extra, pc, symbols, line, '9900') & 0xffff));
    if (dest.extra !== undefined) out.push(...wordBytes(evalExpr(dest.extra, pc, symbols, line, '9900') & 0xffff));
    return out;
  }
  if (JUMPS[op] !== undefined) {
    const target = evalExpr(args, pc, symbols, line, '9900') & 0xffff;
    const disp = (target - (pc + 2)) / 2;
    if (!Number.isInteger(disp) || disp < -128 || disp > 127) throw new RetroError(`jump to ${args} is out of range`, line, 1);
    const byte = disp < 0 ? disp + 256 : disp;
    return wordBytes((JUMPS[op] ?? 0) | (byte & 0xff));
  }
  if (SINGLES[op]) {
    const ga = parseGA(args, line);
    const word = ((SINGLES[op] ?? 0) | ((ga.t & 3) << 4) | (ga.r & 15)) & 0xffff;
    const out = wordBytes(word);
    if (ga.extra !== undefined) out.push(...wordBytes(evalExpr(ga.extra, pc, symbols, line, '9900') & 0xffff));
    return out;
  }
  if (SHIFTS[op]) {
    const [regText, countText] = splitArgs(args);
    const reg = regNum(regText ?? 'R0', line);
    const count = countText ? evalExpr(countText, pc, symbols, line, '9900') & 15 : 0;
    return wordBytes((SHIFTS[op] ?? 0) | (count << 4) | reg);
  }
  if (IMM[op]) {
    const [regText, valueText] = splitArgs(args);
    const reg = regNum(regText ?? 'R0', line);
    const value = evalExpr(valueText ?? '0', pc, symbols, line, '9900') & 0xffff;
    return [...wordBytes((IMM[op] ?? 0) | reg), ...wordBytes(value)];
  }
  if (op === 'LWPI' || op === 'LIMI') {
    const value = evalExpr(args, pc, symbols, line, '9900') & 0xffff;
    return [...wordBytes(FIXED[op] ?? 0), ...wordBytes(value)];
  }
  if (op === 'STWP' || op === 'STST') return wordBytes((FIXED[op] ?? 0) | regNum(args, line));
  if (FIXED[op] !== undefined) return wordBytes(FIXED[op] ?? 0);
  throw new RetroError(`unknown TMS9900 instruction ${op}`, line, 1);
}

function pseudo(op: string, args: string, line: number): { op: string; args: string; line: number } {
  return { op, args, line };
}

function wordBytes(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function operands(args: string, line: number): [GA | null, GA | null] {
  const parts = splitArgs(args);
  return [parts[0] ? parseGA(parts[0], line) : null, parts[1] ? parseGA(parts[1], line) : null];
}

function parseGA(text: string, line: number): GA {
  const src = text.trim();
  let match = /^\*R(\d+)\+$/i.exec(src) ?? /^\*(\d+)\+$/.exec(src);
  if (match?.[1]) return { t: 3, r: checkReg(Number(match[1]), line) };
  match = /^\*R(\d+)$/i.exec(src) ?? /^\*(\d+)$/.exec(src);
  if (match?.[1]) return { t: 1, r: checkReg(Number(match[1]), line) };
  match = /^@([^()]+?)(?:\(R(\d+)\))?$/i.exec(src);
  if (match?.[1]) return { t: 2, r: match[2] ? checkReg(Number(match[2]), line) : 0, extra: match[1].trim() };
  return { t: 0, r: regNum(src, line) };
}

function regNum(text: string, line: number): number {
  const match = /^R(\d+)$/i.exec(text.trim()) ?? /^(\d+)$/.exec(text.trim());
  if (!match?.[1]) throw new RetroError(`expected a register, got ${text}`, line, 1);
  return checkReg(Number(match[1]), line);
}

function checkReg(n: number, line: number): number {
  if (n < 0 || n > 15) throw new RetroError(`register R${n} is out of range`, line, 1);
  return n;
}

function rawBytes(op: string, args: string, line: number, pc = 0, symbols?: Map<string, number>): number[] {
  if (op === 'TEXT') {
    const out: number[] = [];
    for (const part of splitArgs(args)) {
      if (!((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'")))) {
        throw new RetroError('TEXT needs a string', line, 1);
      }
      for (const ch of part.slice(1, -1)) out.push(ch.charCodeAt(0) & 0xff);
    }
    return out;
  }
  const out: number[] = [];
  for (const part of splitArgs(args)) {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'") && part.length !== 3)) {
      for (const ch of part.slice(1, -1)) out.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const value = symbols ? evalExpr(part, pc, symbols, line, '9900') : Number(part);
    out.push(value & 0xff);
  }
  return out;
}

const L = 0x8000;
const AG = 0x4000;
const EQ = 0x2000;
const CARRY = 0x1000;
const OV = 0x0800;
const PAR = 0x0400;

export function run9900(program: string | AsmImage, options: { maxCycles?: number; org?: number } = {}): CpuResult {
  const image = typeof program === 'string' ? assemble9900(program, options) : program;
  const mem = new Uint8Array(65536);
  mem.set(image.bytes, image.org);
  let wp = 0;
  let pc = image.entry & 0xffff;
  let st = 0;
  let cycles = 0;
  let output = '';
  let halted = 'max';
  const readWord = (addr: number): number => ((mem[addr & 0xffff] ?? 0) << 8) | (mem[(addr + 1) & 0xffff] ?? 0);
  const writeByte = (addr: number, value: number): void => {
    const at = addr & 0xffff;
    mem[at] = value & 0xff;
    if (at === 0x8c00) {
      const ch = value & 0xff;
      output += ch === 13 || ch === 10 ? '\n' : ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '';
    }
  };
  const writeWord = (addr: number, value: number): void => {
    writeByte(addr, (value >> 8) & 0xff);
    writeByte(addr + 1, value & 0xff);
  };
  const regAddr = (n: number): number => (wp + (n & 15) * 2) & 0xffff;
  const readReg = (n: number): number => readWord(regAddr(n));
  const writeReg = (n: number, value: number): void => writeWord(regAddr(n), value);
  const fetch = (): number => {
    const word = readWord(pc);
    pc = (pc + 2) & 0xffff;
    return word;
  };
  const addressOf = (t: number, r: number, byte: boolean): number => {
    if (t === 0) return regAddr(r);
    if (t === 1) return readReg(r) & 0xffff;
    if (t === 2) {
      const base = fetch();
      return (base + (r === 0 ? 0 : readReg(r))) & 0xffff;
    }
    const addr = readReg(r) & 0xffff;
    writeReg(r, (addr + (byte ? 1 : 2)) & 0xffff);
    return addr;
  };
  const readValue = (addr: number, byte: boolean, isReg: boolean): number => {
    if (!byte) return readWord(addr);
    return isReg ? (mem[addr] ?? 0) : (mem[addr] ?? 0);
  };
  const writeValue = (addr: number, value: number, byte: boolean): void => {
    if (byte) writeByte(addr, value);
    else writeWord(addr, value);
  };
  const logic = (value: number, bits: number): void => {
    const mask = bits === 8 ? 0xff : 0xffff;
    const v = value & mask;
    const eq = v === 0;
    const neg = bits === 8 ? (v & 0x80) !== 0 : (v & 0x8000) !== 0;
    st = (st & ~(L | AG | EQ | PAR)) | (eq ? 0 : L) | (!eq && !neg ? AG : 0) | (eq ? EQ : 0);
    if (bits === 8) {
      let ones = 0;
      for (let i = 0; i < 8; i += 1) if (v & (1 << i)) ones += 1;
      if ((ones & 1) === 0) st |= PAR;
    }
  };
  const carryOv = (carry: boolean, overflow: boolean): void => {
    st = (st & ~(CARRY | OV)) | (carry ? CARRY : 0) | (overflow ? OV : 0);
  };

  while (cycles < (options.maxCycles ?? 2_000_000)) {
    if (pc & 1) {
      halted = 'odd';
      break;
    }
    const at = pc;
    const op = fetch();
    cycles += 1;
    const dual = dualOf(op);
    if (dual) {
      const td = (op >> 10) & 3;
      const d = (op >> 6) & 15;
      const ts = (op >> 4) & 3;
      const s = op & 15;
      const srcAddr = addressOf(ts, s, dual.byte);
      const srcReg = ts === 0;
      const src = readValue(srcAddr, dual.byte, srcReg);
      const destAddr = addressOf(td, d, dual.byte);
      const dest = readValue(destAddr, dual.byte, td === 0);
      applyDual(dual.name, src, dest, destAddr, d, td === 0, dual.byte);
      continue;
    }
    const jump = jumpOf(op);
    if (jump) {
      const disp = (op & 0xff) << 24 >> 24;
      const target = (pc + disp * 2) & 0xffff;
      if (jump === 'JMP' || takeJump(jump)) {
        if (target === at) {
          halted = 'jmp';
          pc = target;
          break;
        }
        pc = target;
      }
      continue;
    }
    const single = singleOf(op);
    if (single) {
      const t = (op >> 4) & 3;
      const r = op & 15;
      const addr = addressOf(t, r, false);
      applySingle(single, addr, t === 0, r);
      continue;
    }
    const shift = shiftOf(op);
    if (shift) {
      let count = (op >> 4) & 15;
      const reg = op & 15;
      if (count === 0) count = readReg(0) & 15;
      if (count === 0) count = 16;
      applyShift(shift, reg, count);
      continue;
    }
    if ((op & 0xffe0) === IMM.LI) {
      writeReg(op & 15, fetch());
      logic(readReg(op & 15), 16);
      continue;
    }
    if ((op & 0xffe0) === IMM.AI) {
      const reg = op & 15;
      const next = add16(readReg(reg), fetch());
      writeReg(reg, next.result);
      logic(next.result, 16);
      carryOv(next.carry, next.overflow);
      continue;
    }
    if ((op & 0xffe0) === IMM.ANDI) {
      const reg = op & 15;
      const result = readReg(reg) & fetch();
      writeReg(reg, result);
      logic(result, 16);
      continue;
    }
    if ((op & 0xffe0) === IMM.ORI) {
      const reg = op & 15;
      const result = readReg(reg) | fetch();
      writeReg(reg, result);
      logic(result, 16);
      continue;
    }
    if ((op & 0xffe0) === IMM.CI) {
      compare(readReg(op & 15), fetch(), 16);
      continue;
    }
    if ((op & 0xffe0) === FIXED.STWP) {
      writeReg(op & 15, wp);
      continue;
    }
    if ((op & 0xffe0) === FIXED.STST) {
      writeReg(op & 15, st);
      continue;
    }
    if (op === FIXED.LWPI) {
      wp = fetch();
      continue;
    }
    if (op === FIXED.LIMI) {
      fetch();
      continue;
    }
    if (op === FIXED.IDLE) {
      halted = 'idle';
      break;
    }
    if (op === FIXED.RTWP) {
      const nwp = readReg(13);
      const npc = readReg(14);
      const nst = readReg(15);
      wp = nwp;
      pc = npc;
      st = nst;
      continue;
    }
    if (op === FIXED.RSET || op === FIXED.CKON || op === FIXED.CKOF || op === FIXED.LREX) continue;
    if ((op & 0xfc00) === 0x3000 || (op & 0xfc00) === 0x3400) {
      addressOf((op >> 4) & 3, op & 15, true);
      continue;
    }
    halted = `illegal >${op.toString(16)}`;
    break;
  }

  const registers = new Uint16Array(16);
  for (let i = 0; i < 16; i += 1) registers[i] = readReg(i);
  return { output, cycles, halted, pc, memory: mem, registers };

  function applyDual(name: string, src: number, dest: number, destAddr: number, destReg: number, destIsReg: boolean, byte: boolean): void {
    const bits = byte ? 8 : 16;
    const mask = byte ? 0xff : 0xffff;
    const write = (result: number): void => writeValue(destAddr, result & mask, byte);
    if (name === 'MOV' || name === 'MOVB') {
      write(src);
      logic(src, bits);
      return;
    }
    if (name === 'A' || name === 'AB') {
      const next = byte ? add8(dest, src) : add16(dest, src);
      write(next.result);
      logic(next.result, bits);
      carryOv(next.carry, next.overflow);
      return;
    }
    if (name === 'S' || name === 'SB') {
      const next = byte ? add8(dest, (~src) & 0xff, true) : add16(dest, (~src) & 0xffff, true);
      write(next.result);
      logic(next.result, bits);
      carryOv(next.carry, next.overflow);
      return;
    }
    if (name === 'C' || name === 'CB') {
      compare(src, dest, bits);
      return;
    }
    if (name === 'SOC' || name === 'SOCB') {
      const result = (dest | src) & mask;
      write(result);
      logic(result, bits);
      return;
    }
    if (name === 'SZC' || name === 'SZCB') {
      const result = (dest & ~src) & mask;
      write(result);
      logic(result, bits);
      return;
    }
    if (name === 'MPY') {
      const product = (src & 0xffff) * (readReg(destReg) & 0xffff);
      writeReg(destReg, (product >> 16) & 0xffff);
      writeReg(destReg + 1, product & 0xffff);
      return;
    }
    if (name === 'DIV') {
      const dividend = ((readReg(destReg) & 0xffff) * 65536) + (readReg((destReg + 1) & 15) & 0xffff);
      if (src === 0 || (readReg(destReg) & 0xffff) >= (src & 0xffff)) {
        st |= OV;
        return;
      }
      writeReg(destReg, Math.floor(dividend / src) & 0xffff);
      writeReg((destReg + 1) & 15, dividend % src);
      st &= ~OV;
    }
  }

  function applySingle(name: string, addr: number, isReg: boolean, reg: number): void {
    const value = readWord(addr);
    if (name === 'B' || name === 'BL') {
      if (name === 'BL') writeReg(11, pc);
      if (name === 'B' && addr === ((pc - 2) & 0xffff)) {
        halted = 'jmp';
        pc = addr;
        return;
      }
      pc = addr & 0xffff;
      return;
    }
    if (name === 'BLWP') {
      const nwp = readWord(addr);
      const npc = readWord(addr + 2);
      const oldWp = wp;
      const oldPc = pc;
      const oldSt = st;
      wp = nwp;
      writeReg(13, oldWp);
      writeReg(14, oldPc);
      writeReg(15, oldSt);
      pc = npc & 0xffff;
      return;
    }
    if (name === 'X') {
      const saved = pc;
      pc = addr & 0xffff;
      const nested = run9900({ cpu: '9900', org: pc, bytes: mem.slice(pc, pc + 8), symbols: {}, entry: pc, image: mem.slice(pc, pc + 8), format: 'bin' }, { maxCycles: 1 });
      pc = nested.halted === 'jmp' ? nested.pc : saved;
      return;
    }
    const math = (result: number, carry = false, overflow = false): void => {
      writeWord(addr, result);
      logic(result, 16);
      carryOv(carry, overflow);
    };
    if (name === 'CLR') return math(0);
    if (name === 'SETO') return math(0xffff);
    if (name === 'INV') return math(~value & 0xffff);
    if (name === 'NEG') return math((-value) & 0xffff, value === 0, value === 0x8000);
    if (name === 'ABS') return math(value & 0x8000 ? (-value) & 0xffff : value, false, value === 0x8000);
    if (name === 'INC') return math(add16(value, 1).result, add16(value, 1).carry, add16(value, 1).overflow);
    if (name === 'INCT') return math(add16(value, 2).result, add16(value, 2).carry, add16(value, 2).overflow);
    if (name === 'DEC') return math(add16(value, 0xffff).result, add16(value, 0xffff).carry, add16(value, 0xffff).overflow);
    if (name === 'DECT') return math(add16(value, 0xfffe).result, add16(value, 0xfffe).carry, add16(value, 0xfffe).overflow);
    if (name === 'SWPB') return math(((value & 0xff) << 8) | ((value >> 8) & 0xff));
    if (name === 'CLR' || isReg || reg) return;
  }

  function applyShift(name: string, reg: number, count: number): void {
    let value = readReg(reg);
    let carry = false;
    let overflow = false;
    const sign = value & 0x8000;
    for (let i = 0; i < count; i += 1) {
      if (name === 'SRL') {
        carry = (value & 1) !== 0;
        value = (value >>> 1) & 0xffff;
      } else if (name === 'SRA') {
        carry = (value & 1) !== 0;
        value = ((value >>> 1) | (value & 0x8000)) & 0xffff;
      } else if (name === 'SLA') {
        carry = (value & 0x8000) !== 0;
        value = (value << 1) & 0xffff;
        if ((value & 0x8000) !== sign) overflow = true;
      } else {
        carry = (value & 1) !== 0;
        value = ((value >>> 1) | (carry ? 0x8000 : 0)) & 0xffff;
      }
    }
    writeReg(reg, value);
    logic(value, 16);
    carryOv(carry, overflow);
  }

  function takeJump(name: string): boolean {
    const l = (st & L) !== 0;
    const a = (st & AG) !== 0;
    const eq = (st & EQ) !== 0;
    const c = (st & CARRY) !== 0;
    const o = (st & OV) !== 0;
    const p = (st & PAR) !== 0;
    switch (name) {
      case 'JLT':
        return !a && !eq;
      case 'JLE':
        return !l;
      case 'JEQ':
        return eq;
      case 'JHE':
        return l || eq;
      case 'JGT':
        return a;
      case 'JNE':
        return !eq;
      case 'JNC':
        return !c;
      case 'JOC':
        return c;
      case 'JNO':
        return !o;
      case 'JL':
        return !l && !eq;
      case 'JH':
        return l;
      case 'JOP':
        return p;
      default:
        return false;
    }
  }

  function compare(src: number, dest: number, bits: number): void {
    const mask = bits === 8 ? 0xff : 0xffff;
    const left = src & mask;
    const right = dest & mask;
    const signed = (n: number): number => (bits === 8 ? (n << 24) >> 24 : (n << 16) >> 16);
    const eq = left === right;
    const lgt = left > right;
    const agt = signed(left) > signed(right);
    st = (st & ~(L | AG | EQ | CARRY)) | (lgt ? L : 0) | (agt ? AG : 0) | (eq ? EQ : 0) | (left >= right ? CARRY : 0);
  }
}

function dualOf(op: number): { name: string; byte: boolean } | null {
  if ((op & 0xfc00) === DUALS.MPY?.base) return { name: 'MPY', byte: false };
  if ((op & 0xfc00) === DUALS.DIV?.base) return { name: 'DIV', byte: false };
  const hi = op & 0xf000;
  for (const [name, spec] of Object.entries(DUALS)) {
    if (spec.base === hi) return { name, byte: spec.byte };
  }
  return null;
}

function jumpOf(op: number): string | null {
  const base = op & 0xff00;
  for (const [name, value] of Object.entries(JUMPS)) if (value === base) return name;
  return null;
}

function singleOf(op: number): string | null {
  const base = op & 0xffc0;
  for (const [name, value] of Object.entries(SINGLES)) if (value === base) return name;
  return null;
}

function shiftOf(op: number): string | null {
  const base = op & 0xff00;
  for (const [name, value] of Object.entries(SHIFTS)) if (value === base) return name;
  return null;
}

function add16(left: number, right: number, plusOne = false): { result: number; carry: boolean; overflow: boolean } {
  const sum = (left & 0xffff) + (right & 0xffff) + (plusOne ? 1 : 0);
  const result = sum & 0xffff;
  const overflow = ((left ^ right) & 0x8000) === 0 && ((left ^ result) & 0x8000) !== 0;
  return { result, carry: sum > 0xffff, overflow };
}

function add8(left: number, right: number, plusOne = false): { result: number; carry: boolean; overflow: boolean } {
  const sum = (left & 0xff) + (right & 0xff) + (plusOne ? 1 : 0);
  const result = sum & 0xff;
  const overflow = ((left ^ right) & 0x80) === 0 && ((left ^ result) & 0x80) !== 0;
  return { result, carry: sum > 0xff, overflow };
}
