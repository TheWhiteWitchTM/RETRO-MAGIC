export { RetroError, diagnostic } from './error.js';
export type { Diagnostic } from './error.js';

export { TARGETS, MACHINE, PALETTE, glyphFor, graphemes, isEmojiGrapheme, scanText, c64Sprite, tiHex, paint, machineOf } from './glyph.js';
export type { Glyph, TargetName } from './glyph.js';

export { lowerMagic, targetOfFile } from './lower.js';
export { runProgram, evalExpr } from './ir.js';
export type { RProg, RExpr, RStmt, RFn, RSprite, ScreenModel, ScreenCell, ScreenSprite } from './ir.js';

export { emitBasic, resetBasicLabels } from './basic-emit.js';
export { runBasic, checkBasic, tokenizeBasic, BASIC_KEYWORDS } from './basic-run.js';
export type { BasicResult } from './basic-run.js';

export { emitAsm } from './emit-asm.js';
export { assemble6502, run6502, run6502Image, OPS } from './asm6502.js';
export { assemble9900, run9900 } from './asm9900.js';
export type { AsmImage, CpuResult } from './asm-expr.js';

export {
  KEYWORDS,
  compileMagic,
  runMagic,
  checkSource,
  assembleSource,
  runAsm,
  runBasicSource,
  resolveTarget,
} from './compile.js';
export type { CompileOptions, CompileResult, CheckResult } from './compile.js';
