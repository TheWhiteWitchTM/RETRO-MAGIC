/**
 * The door into RETRO-MAGIC.
 * MAGIC lowers to one program. BASIC, 6502, and TMS9900 are listings of it.
 * `runMagic` is the host screen. The listings run on their own interpreters.
 */

import { KEYWORDS as MAGIC_KEYWORDS } from 'magic';
import { assemble6502, OPS, run6502 } from './asm6502.js';
import { assemble9900, run9900 } from './asm9900.js';
import type { AsmImage, CpuResult } from './asm-expr.js';
import { emitAsm } from './emit-asm.js';
import { emitBasic } from './basic-emit.js';
import { BASIC_KEYWORDS, checkBasic, runBasic, tokenizeBasic } from './basic-run.js';
import type { BasicResult } from './basic-run.js';
import { diagnostic, RetroError } from './error.js';
import type { Diagnostic } from './error.js';
import { TARGETS, type TargetName } from './glyph.js';
import { runProgram, type RProg, type ScreenModel } from './ir.js';
import { lowerMagic, targetOfFile } from './lower.js';

export interface CompileOptions {
  filename?: string;
  target?: TargetName;
}

export interface CompileResult {
  target: TargetName;
  prog: RProg;
  basic: string;
  asm: string;
  warnings: string[];
  notes: string[];
  output: string;
  screen: ScreenModel;
  tokens: Uint8Array | null;
  image: AsmImage | null;
  asmError: string | null;
}

export interface CheckResult {
  ok: boolean;
  problems: Diagnostic[];
  warnings: string[];
}

const ASM_9900 = ['A', 'AB', 'ABS', 'AI', 'ANDI', 'B', 'BL', 'BLWP', 'C', 'CB', 'CI', 'CKOF', 'CKON', 'CLR', 'DEC', 'DECT', 'DIV', 'IDLE', 'INC', 'INCT', 'INV', 'JEQ', 'JGT', 'JH', 'JHE', 'JL', 'JLE', 'JLT', 'JMP', 'JNC', 'JNE', 'JNO', 'JOC', 'JOP', 'LI', 'LIMI', 'LREX', 'LWPI', 'MOV', 'MOVB', 'MPY', 'NEG', 'NOP', 'ORI', 'RSET', 'RT', 'RTWP', 'S', 'SB', 'SBO', 'SBZ', 'SETO', 'SLA', 'SOC', 'SOCB', 'SRA', 'SRC', 'SRL', 'STST', 'STWP', 'SWPB', 'SZC', 'SZCB', 'TB', 'X'];

export const KEYWORDS = {
  magic: [...MAGIC_KEYWORDS],
  basic: BASIC_KEYWORDS,
  asm6502: Object.keys(OPS),
  asm9900: ASM_9900,
};

export function resolveTarget(source: string, options: CompileOptions = {}): TargetName {
  if (options.target) return options.target;
  return targetOfFile(source, options.filename ?? '') ?? 'c64';
}

export function compileMagic(source: string, options: CompileOptions = {}): CompileResult {
  const target = resolveTarget(source, options);
  const filename = options.filename ?? '';
  const prog = lowerMagic(source, filename, target);
  const screen = runProgram(prog);
  const basic = emitBasic(prog);
  const asm = emitAsm(prog);
  let tokens: Uint8Array | null = null;
  if (target === 'c64' || target === 'apple2') {
    try {
      tokens = tokenizeBasic(basic, target);
    } catch {
      tokens = null;
    }
  }
  let image: AsmImage | null = null;
  let asmError: string | null = null;
  try {
    image = target === 'ti99' ? assemble9900(asm) : assemble6502(asm, { target });
  } catch (error) {
    asmError = error instanceof Error ? error.message : String(error);
  }
  return {
    target,
    prog,
    basic,
    asm,
    warnings: prog.warnings,
    notes: prog.notes,
    output: screen.output,
    screen,
    tokens,
    image,
    asmError,
  };
}

export function runMagic(source: string, options: CompileOptions = {}): ScreenModel {
  const target = resolveTarget(source, options);
  return runProgram(lowerMagic(source, options.filename ?? '', target));
}

export function checkSource(source: string, options: CompileOptions = {}): CheckResult {
  try {
    const target = resolveTarget(source, options);
    const prog = lowerMagic(source, options.filename ?? '', target);
    return { ok: true, problems: [], warnings: prog.warnings };
  } catch (error) {
    if (error instanceof RetroError) return { ok: false, problems: [diagnostic(error)], warnings: [] };
    throw error;
  }
}

export function assembleSource(source: string, options: { cpu?: '6502' | '9900'; target?: TargetName; org?: number } = {}): AsmImage {
  const cpu = options.cpu ?? (options.target === 'ti99' ? '9900' : '6502');
  if (cpu === '9900') return assemble9900(source, { org: options.org });
  return assemble6502(source, { org: options.org, target: options.target === 'ti99' ? 'c64' : options.target });
}

export function runAsm(source: string, options: { cpu?: '6502' | '9900'; target?: TargetName; org?: number; maxCycles?: number } = {}): CpuResult {
  const cpu = options.cpu ?? (options.target === 'ti99' ? '9900' : '6502');
  if (cpu === '9900') return run9900(source, { org: options.org, maxCycles: options.maxCycles });
  return run6502(source, { org: options.org, target: options.target === 'ti99' ? 'c64' : options.target, maxCycles: options.maxCycles });
}

export function runBasicSource(source: string, options: { target?: TargetName; filename?: string; maxSteps?: number; input?: string[] } = {}): BasicResult {
  return runBasic(source, options);
}

export { TARGETS, checkBasic, tokenizeBasic };
