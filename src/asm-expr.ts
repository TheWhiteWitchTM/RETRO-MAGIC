/**
 * Shared assembly source reader.
 * `$` alone is the address of the current item.
 * `>` is a hex number on the TI, and the high byte on the 6502.
 */

import { RetroError } from './error.js';

export interface AsmLine {
  line: number;
  label: string;
  op: string;
  args: string;
}

const DIRECTIVES = new Set(['ORG', 'AORG', 'BYTE', 'DB', 'WORD', 'DW', 'DATA', 'TEXT', 'ALIGN', 'EVEN', 'RES', 'BSS', 'EQU', 'END', 'INCLUDE']);

export function parseProgram(source: string): AsmLine[] {
  const out: AsmLine[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = stripComment(lines[i] ?? '');
    if (!raw.trim()) continue;
    if (/^\s*\*/.test(raw)) continue;
    out.push(parseOne(raw.trim(), i + 1));
  }
  return out;
}

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';') return text.slice(0, i);
  }
  return text;
}

function parseOne(text: string, line: number): AsmLine {
  let src = text.trim();
  let label = '';
  const colon = /^([A-Za-z_.][A-Za-z0-9_.]*)\s*:\s*/.exec(src);
  if (colon?.[1]) {
    label = colon[1];
    src = src.slice(colon[0].length).trim();
  }
  if (!src) return { line, label, op: '', args: '' };
  const equ = /^([A-Za-z_.][A-Za-z0-9_.]*)\s+(?:EQU|=)\s+([\s\S]+)$/i.exec(src);
  if (equ?.[1] && equ[2]) return { line, label: label || equ[1], op: 'EQU', args: equ[2].trim() };
  const bareEqu = /^(?:EQU|=)\s+([\s\S]+)$/i.exec(src);
  if (bareEqu?.[1] && label) return { line, label, op: 'EQU', args: bareEqu[1].trim() };
  const word = /^([.A-Za-z][A-Za-z0-9.]*)\s*([\s\S]*)$/.exec(src);
  if (!word?.[1]) throw new RetroError('bad assembly line', line, 1);
  let op = word[1];
  let args = (word[2] ?? '').trim();
  if (!label && args && !op.startsWith('.') && DIRECTIVES.has(args.split(/\s+/)[0]?.toUpperCase() ?? '') === false) {
    const second = /^([.A-Za-z][A-Za-z0-9.]*)\b/.exec(args);
    const secondWord = second?.[1]?.toUpperCase() ?? '';
    if (second && (DIRECTIVES.has(secondWord) || secondWord === op.toUpperCase())) {
      /* keep */
    }
  }
  if (!label) {
    const two = /^([A-Za-z_.][A-Za-z0-9_.]*)\s+([.A-Za-z][A-Za-z0-9.]*)\b\s*([\s\S]*)$/.exec(src);
    const maybeOp = two?.[2]?.replace(/^\./, '').toUpperCase() ?? '';
    if (two?.[1] && two[2] && (DIRECTIVES.has(maybeOp) || looksLikeInstruction(maybeOp, two[3] ?? ''))) {
      const mnemonic = two[2].toUpperCase();
      if (DIRECTIVES.has(maybeOp) || MNEMONICS.has(maybeOp)) {
        label = two[1];
        op = mnemonic;
        args = (two[3] ?? '').trim();
      }
    }
  }
  if (op.startsWith('.')) op = op.slice(1);
  return { line, label, op: op.toUpperCase(), args };
}

const MNEMONICS = new Set<string>();

export function registerMnemonics(names: string[]): void {
  for (const name of names) MNEMONICS.add(name.toUpperCase());
}

function looksLikeInstruction(op: string, _args: string): boolean {
  return MNEMONICS.has(op.toUpperCase()) || DIRECTIVES.has(op.toUpperCase());
}

export function evalExpr(input: string, pc: number, symbols: Map<string, number>, line: number, cpu: '6502' | '9900'): number {
  const parser = new ExprParser(input.trim(), pc, symbols, line, cpu);
  if (!input.trim()) throw new RetroError('expression is missing', line, 1);
  const value = parser.parseOr();
  parser.skip();
  if (parser.i < parser.text.length) throw new RetroError(`leftover "${parser.text.slice(parser.i)}" in an expression`, line, parser.i + 1);
  return value | 0;
}

class ExprParser {
  i = 0;

  constructor(
    readonly text: string,
    readonly pc: number,
    readonly symbols: Map<string, number>,
    readonly line: number,
    readonly cpu: '6502' | '9900',
  ) {}

  parseOr(): number {
    let left = this.parseXor();
    for (;;) {
      this.skip();
      if (this.peek() !== '|') break;
      this.i += 1;
      left |= this.parseXor();
    }
    return left;
  }

  parseXor(): number {
    let left = this.parseAnd();
    for (;;) {
      this.skip();
      if (this.peek() !== '^') break;
      this.i += 1;
      left ^= this.parseAnd();
    }
    return left;
  }

  parseAnd(): number {
    let left = this.parseShift();
    for (;;) {
      this.skip();
      if (this.peek() !== '&') break;
      this.i += 1;
      left &= this.parseShift();
    }
    return left;
  }

  parseShift(): number {
    let left = this.parseAdd();
    for (;;) {
      this.skip();
      if (this.text.startsWith('<<', this.i)) {
        this.i += 2;
        left <<= this.parseAdd();
        continue;
      }
      if (this.text.startsWith('>>', this.i)) {
        this.i += 2;
        left >>= this.parseAdd();
        continue;
      }
      break;
    }
    return left;
  }

  parseAdd(): number {
    let left = this.parseMul();
    for (;;) {
      this.skip();
      const ch = this.peek();
      if (ch !== '+' && ch !== '-') break;
      this.i += 1;
      const right = this.parseMul();
      left = ch === '+' ? left + right : left - right;
    }
    return left;
  }

  parseMul(): number {
    let left = this.parseUnary();
    for (;;) {
      this.skip();
      const ch = this.peek();
      if (ch !== '*' && ch !== '/') break;
      this.i += 1;
      const right = this.parseUnary();
      if (ch === '/' && right === 0) throw new RetroError('division by zero', this.line, this.i);
      left = ch === '*' ? left * right : Math.trunc(left / right);
    }
    return left;
  }

  parseUnary(): number {
    this.skip();
    const ch = this.peek();
    if (ch === '+') {
      this.i += 1;
      return this.parseUnary();
    }
    if (ch === '-') {
      this.i += 1;
      return -this.parseUnary();
    }
    if (ch === '~') {
      this.i += 1;
      return ~this.parseUnary();
    }
    if (ch === '<' && this.cpu === '6502') {
      this.i += 1;
      return this.parseUnary() & 0xff;
    }
    if (ch === '>' && this.cpu === '6502') {
      this.i += 1;
      return (this.parseUnary() >> 8) & 0xff;
    }
    return this.parseAtom();
  }

  parseAtom(): number {
    this.skip();
    const ch = this.peek();
    if (ch === '(') {
      this.i += 1;
      const value = this.parseOr();
      this.skip();
      if (this.peek() !== ')') throw new RetroError('missing )', this.line, this.i + 1);
      this.i += 1;
      return value;
    }
    if (ch === '$' && !/[0-9A-Fa-f]/.test(this.text[this.i + 1] ?? '')) {
      this.i += 1;
      return this.pc;
    }
    if (ch === '*' && !/[0-9]/.test(this.text[this.i + 1] ?? '') && this.cpu === '9900') {
      this.i += 1;
      return this.pc;
    }
    const num = this.readNumber();
    if (num !== null) return num;
    const name = this.readName();
    if (name) {
      const key = name.toUpperCase();
      if (!this.symbols.has(key)) throw new RetroError(`unknown label ${name}`, this.line, this.i);
      return this.symbols.get(key) ?? 0;
    }
    throw new RetroError('bad expression', this.line, this.i + 1);
  }

  readNumber(): number | null {
    const rest = this.text.slice(this.i);
    let match = /^0x([0-9A-Fa-f]+)/.exec(rest);
    if (match?.[1]) {
      this.i += match[0].length;
      return parseInt(match[1], 16);
    }
    match = /^\$([0-9A-Fa-f]+)/.exec(rest);
    if (match?.[1]) {
      this.i += match[0].length;
      return parseInt(match[1], 16);
    }
    match = /^%([01]+)/.exec(rest);
    if (match?.[1]) {
      this.i += match[0].length;
      return parseInt(match[1], 2);
    }
    match = /^>([0-9A-Fa-f]+)/.exec(rest);
    if (match?.[1] && (match[1].length <= 4 || /[0-9]/.test(match[1]))) {
      this.i += match[0].length;
      return parseInt(match[1], 16);
    }
    match = /^[0-9]+/.exec(rest);
    if (match) {
      this.i += match[0].length;
      return parseInt(match[0], 10);
    }
    match = /^'(\\?.)'/.exec(rest);
    if (match?.[1]) {
      this.i += match[0].length;
      return match[1].startsWith('\\') ? (match[1].charCodeAt(1) ?? 0) : (match[1].charCodeAt(0) ?? 0);
    }
    return null;
  }

  readName(): string {
    const match = /^[A-Za-z_.][A-Za-z0-9_.]*/.exec(this.text.slice(this.i));
    if (!match) return '';
    this.i += match[0].length;
    return match[0];
  }

  skip(): void {
    while (this.text[this.i] === ' ' || this.text[this.i] === '\t') this.i += 1;
  }

  peek(): string {
    this.skip();
    return this.text[this.i] ?? '';
  }
}

export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = args.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export interface AsmImage {
  cpu: '6502' | '9900';
  org: number;
  bytes: Uint8Array;
  symbols: Record<string, number>;
  entry: number;
  image: Uint8Array;
  format: 'prg' | 'apple' | 'bin';
}

export interface CpuResult {
  output: string;
  cycles: number;
  halted: string;
  pc: number;
  memory: Uint8Array;
  registers?: Uint16Array;
  a?: number;
  x?: number;
  y?: number;
}

export function bytesOfItem(item: string, line: number): number[] {
  const text = item.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'") && text.length > 3)) {
    const body = text.slice(1, -1);
    return [...body].map((ch) => ch.charCodeAt(0) & 0xff);
  }
  return [];
}
