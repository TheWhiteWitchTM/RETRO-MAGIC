/**
 * Retro program to 6502 or TMS9900 source.
 * The runners share one idea: an expression stack, then print, add, and compare.
 * Sprite pixels are not drawn here. Positions and collisions are, so the text matches.
 */

import type { RExpr, RFn, RProg, RStmt } from './ir.js';

export function emitAsm(prog: RProg): string {
  return prog.target === 'ti99' ? emit9900(prog) : emit6502(prog);
}

class Out {
  private readonly lines: string[] = [];
  private n = 0;
  readonly breaks: string[] = [];
  readonly conts: string[] = [];

  write(text: string): void {
    this.lines.push(text);
  }

  label(name: string): void {
    this.lines.push(`${name}:`);
  }

  inst(text: string): void {
    this.lines.push(`  ${text}`);
  }

  fresh(prefix: string): string {
    this.n += 1;
    return `${prefix}${this.n}`;
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

function san(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9]/g, '_').replace(/^_+/, '').toUpperCase();
  const base = clean || 'V';
  return /^[0-9]/.test(base) ? `V_${base}` : base;
}

function vname(name: string): string {
  return `V_${san(name)}`;
}

function words(n: number): { lo: number; hi: number } {
  const value = Math.trunc(n) & 0xffff;
  return { lo: value & 0xff, hi: (value >> 8) & 0xff };
}

function collect(prog: RProg): Map<string, boolean> {
  const names = new Map<string, boolean>();
  const expr = (node: RExpr | null | undefined): void => {
    if (!node) return;
    if (node.t === 'v') names.set(node.name, node.str);
    if (node.t === 'bin') {
      expr(node.a);
      expr(node.b);
    }
    if (node.t === 'un') expr(node.a);
    if (node.t === 'fn') node.args.forEach(expr);
  };
  const stmts = (list: RStmt[]): void => {
    for (const stmt of list) {
      if (stmt.t === 'let') {
        names.set(stmt.name, stmt.str);
        expr(stmt.expr);
      }
      if (stmt.t === 'print') stmt.args.forEach(expr);
      if (stmt.t === 'if') {
        expr(stmt.cond);
        stmts(stmt.yes);
        stmts(stmt.no);
      }
      if (stmt.t === 'for') {
        names.set(stmt.name, false);
        expr(stmt.from);
        expr(stmt.to);
        expr(stmt.step);
        stmts(stmt.body);
      }
      if (stmt.t === 'while' || stmt.t === 'repeat') {
        expr(stmt.cond);
        stmts(stmt.body);
      }
      if (stmt.t === 'gosub') {
        for (const arg of stmt.args) {
          names.set(arg.name, arg.str);
          expr(arg.expr);
        }
        if (stmt.ret) names.set(stmt.ret.name, stmt.ret.str);
      }
      if (stmt.t === 'return') expr(stmt.expr);
      if (stmt.t === 'motion' || stmt.t === 'tone') {
        expr(stmt.t === 'motion' ? stmt.dx : stmt.freq);
        expr(stmt.t === 'motion' ? stmt.dy : stmt.ms);
      }
      if (stmt.t === 'locate') {
        expr(stmt.col);
        expr(stmt.row);
      }
      if (stmt.t === 'write') expr(stmt.text);
      if (stmt.t === 'poke') {
        expr(stmt.addr);
        expr(stmt.value);
      }
    }
  };
  stmts(prog.main);
  stmts(prog.hit);
  for (const fn of prog.fns) {
    for (const param of fn.params) names.set(param.name, param.str);
    if (fn.ret) names.set(fn.ret.name, fn.ret.str);
    stmts(fn.body);
  }
  for (const sprite of prog.sprites) {
    for (const slot of [sprite.x, sprite.y, sprite.dx, sprite.dy, sprite.size, sprite.alive]) names.set(slot, false);
  }
  return names;
}

function emit6502(prog: RProg): string {
  const out = new Out();
  const strings: string[] = [];
  const pool = new Map<string, string>();
  const strLab = (text: string): string => {
    const hit = pool.get(text);
    if (hit) return hit;
    const name = `S${pool.size}`;
    pool.set(text, name);
    strings.push(name);
    return name;
  };
  strLab('');
  const org = prog.target === 'apple2' ? '$6000' : '$0900';
  const chrout = prog.target === 'apple2' ? '$FDED' : '$FFD2';
  out.write(`; RETRO-MAGIC ${prog.target}`);
  for (const note of prog.notes) out.write(`; ${note}`);
  out.inst(`.org ${org}`);
  out.inst(`CHROUT = ${chrout}`);
  out.inst('jmp START');
  out.write(RUNTIME_6502);
  for (const fn of prog.fns) emitFn6502(out, prog, fn, strLab);
  if (prog.hit.length) {
    out.label('HITBODY');
    emitBlock6502(out, prog, prog.hit, null, strLab);
    out.inst('rts');
  }
  out.label('START');
  out.inst('ldx #$ff');
  out.inst('txs');
  out.inst('lda #0');
  out.inst('sta $e0');
  out.inst('sta $ec');
  out.inst('lda #$c8');
  out.inst('sta $ed');
  emitBlock6502(out, prog, prog.main, null, strLab);
  out.inst('brk');
  for (const name of strings) {
    const text = [...pool.entries()].find(([, label]) => label === name)?.[0] ?? '';
    out.label(name);
    const bytes = [...text].map((ch) => String(ch.charCodeAt(0) & 0xff));
    bytes.push('0');
    out.inst(`.byte ${bytes.join(',')}`);
  }
  for (const [name] of collect(prog)) {
    out.label(vname(name));
    out.inst('.word 0');
  }
  return out.text();
}

function emitFn6502(out: Out, prog: RProg, fn: RFn, strLab: (text: string) => string): void {
  out.label(`F_${san(fn.name)}`);
  emitBlock6502(out, prog, fn.body, fn, strLab);
  out.label(`F_${san(fn.name)}_END`);
  out.inst('rts');
}

function emitBlock6502(out: Out, prog: RProg, list: RStmt[], fn: RFn | null, strLab: (text: string) => string): void {
  for (const stmt of list) emitStmt6502(out, prog, stmt, fn, strLab);
}

function pushImm(out: Out, value: number): void {
  const parts = words(value);
  out.inst(`lda #${parts.lo}`);
  out.inst(`ldx #${parts.hi}`);
  out.inst('jsr PUSHAX');
}

function pushVar(out: Out, name: string): void {
  const label = vname(name);
  out.inst(`lda ${label}`);
  out.inst(`ldx ${label}+1`);
  out.inst('jsr PUSHAX');
}

function storeTop(out: Out, name: string): void {
  const label = vname(name);
  out.inst('jsr POPAX');
  out.inst(`sta ${label}`);
  out.inst(`stx ${label}+1`);
}

function emitExpr6502(out: Out, expr: RExpr, strLab: (text: string) => string): void {
  switch (expr.t) {
    case 'n':
      pushImm(out, expr.n);
      return;
    case 's':
      out.inst(`lda #<${strLab(expr.s)}`);
      out.inst(`ldx #>${strLab(expr.s)}`);
      out.inst('jsr PUSHAX');
      return;
    case 'v':
      pushVar(out, expr.name);
      return;
    case 'un':
      emitExpr6502(out, expr.a, strLab);
      out.inst(expr.op === '-' ? 'jsr OP_NEG' : 'jsr OP_NOT');
      return;
    case 'fn':
      if (expr.args[0]) emitExpr6502(out, expr.args[0], strLab);
      else pushImm(out, 0);
      out.inst(`jsr FN_${expr.name.toUpperCase()}`);
      return;
    case 'bin': {
      const op = expr.op === '&' ? 'CONCAT' : BIN_6502[expr.op] ?? 'OP_ADD';
      emitExpr6502(out, expr.a, strLab);
      emitExpr6502(out, expr.b, strLab);
      out.inst(`jsr ${op}`);
      return;
    }
    default:
      pushImm(out, 0);
  }
}

const BIN_6502: Record<string, string> = {
  '+': 'OP_ADD',
  '-': 'OP_SUB',
  '*': 'OP_MUL',
  '/': 'OP_DIV',
  '%': 'OP_MOD',
  '==': 'OP_EQ',
  '=': 'OP_EQ',
  '!=': 'OP_NE',
  '<>': 'OP_NE',
  '<': 'OP_LT',
  '>': 'OP_GT',
  '<=': 'OP_LE',
  '>=': 'OP_GE',
  and: 'OP_AND',
  or: 'OP_OR',
};

function jumpIfZero(out: Out, label: string): void {
  const skip = out.fresh('NZ');
  out.inst('jsr POPAX');
  out.inst('cmp #0');
  out.inst(`bne ${skip}`);
  out.inst('cpx #0');
  out.inst(`bne ${skip}`);
  out.inst(`jmp ${label}`);
  out.label(skip);
}

function jumpIfNotZero(out: Out, label: string): void {
  const go = out.fresh('NZ');
  const skip = out.fresh('ZR');
  out.inst('jsr POPAX');
  out.inst('cmp #0');
  out.inst(`bne ${go}`);
  out.inst('cpx #0');
  out.inst(`bne ${go}`);
  out.inst(`jmp ${skip}`);
  out.label(go);
  out.inst(`jmp ${label}`);
  out.label(skip);
}

function emitStmt6502(out: Out, prog: RProg, stmt: RStmt, fn: RFn | null, strLab: (text: string) => string): void {
  switch (stmt.t) {
    case 'rem':
      out.write(`; ${stmt.text}`);
      return;
    case 'let':
      emitExpr6502(out, stmt.expr, strLab);
      if (stmt.str) {
        out.inst('jsr POPAX');
        out.inst(`sta ${vname(stmt.name)}`);
        out.inst(`stx ${vname(stmt.name)}+1`);
      } else storeTop(out, stmt.name);
      return;
    case 'print':
    case 'write': {
      const args = stmt.t === 'write' ? [stmt.text] : stmt.args;
      args.forEach((arg, index) => {
        if (stmt.t === 'print' && index) {
          out.inst('lda #9');
          out.inst('jsr CHROUT');
        }
        emitExpr6502(out, arg, strLab);
        out.inst('jsr POPAX');
        out.inst(arg.t === 's' || (arg.t === 'v' && arg.str) || (arg.t === 'bin' && arg.op === '&') || (arg.t === 'fn' && (arg.name === 'str' || arg.name === 'chr')) ? 'jsr PRINT_PTR' : 'jsr PRINT_S16');
      });
      if (stmt.t === 'print') {
        out.inst('lda #13');
        out.inst('jsr CHROUT');
      }
      return;
    }
    case 'if': {
      const yes = out.fresh('Y');
      const no = out.fresh('N');
      const end = out.fresh('E');
      emitExpr6502(out, stmt.cond, strLab);
      jumpIfNotZero(out, yes);
      out.inst(`jmp ${no}`);
      out.label(yes);
      emitBlock6502(out, prog, stmt.yes, fn, strLab);
      out.inst(`jmp ${end}`);
      out.label(no);
      emitBlock6502(out, prog, stmt.no, fn, strLab);
      out.label(end);
      return;
    }
    case 'while': {
      const start = out.fresh('W');
      const end = out.fresh('WE');
      out.breaks.push(end);
      out.conts.push(start);
      out.label(start);
      emitExpr6502(out, stmt.cond, strLab);
      jumpIfZero(out, end);
      emitBlock6502(out, prog, stmt.body, fn, strLab);
      out.inst(`jmp ${start}`);
      out.label(end);
      out.breaks.pop();
      out.conts.pop();
      return;
    }
    case 'repeat': {
      const start = out.fresh('R');
      const test = out.fresh('RT');
      const end = out.fresh('RE');
      out.breaks.push(end);
      out.conts.push(test);
      out.label(start);
      emitBlock6502(out, prog, stmt.body, fn, strLab);
      out.label(test);
      emitExpr6502(out, stmt.cond, strLab);
      jumpIfZero(out, start);
      out.label(end);
      out.breaks.pop();
      out.conts.pop();
      return;
    }
    case 'for': {
      const loop = out.fresh('F');
      const cont = out.fresh('FC');
      const end = out.fresh('FE');
      emitExpr6502(out, stmt.from, strLab);
      storeTop(out, stmt.name);
      out.breaks.push(end);
      out.conts.push(cont);
      out.label(loop);
      pushVar(out, stmt.name);
      emitExpr6502(out, stmt.to, strLab);
      const down = stmt.step.t === 'n' && stmt.step.n < 0;
      out.inst(down ? 'jsr OP_LT' : 'jsr OP_GT');
      jumpIfNotZero(out, end);
      emitBlock6502(out, prog, stmt.body, fn, strLab);
      out.label(cont);
      pushVar(out, stmt.name);
      emitExpr6502(out, stmt.step, strLab);
      out.inst('jsr OP_ADD');
      storeTop(out, stmt.name);
      out.inst(`jmp ${loop}`);
      out.label(end);
      out.breaks.pop();
      out.conts.pop();
      return;
    }
    case 'break':
      out.inst(`jmp ${out.breaks[out.breaks.length - 1] ?? 'START'}`);
      return;
    case 'continue':
      out.inst(`jmp ${out.conts[out.conts.length - 1] ?? 'START'}`);
      return;
    case 'return':
      if (stmt.expr && fn?.ret) {
        emitExpr6502(out, stmt.expr, strLab);
        storeTop(out, fn.ret.name);
      }
      out.inst(`jmp F_${san(fn?.name ?? 'MAIN')}_END`);
      return;
    case 'gosub':
      for (const arg of stmt.args) {
        emitExpr6502(out, arg.expr, strLab);
        storeTop(out, arg.name);
      }
      out.inst(`jsr F_${san(stmt.fn)}`);
      return;
    case 'motion': {
      const sprite = prog.sprites.find((item) => item.id === stmt.id);
      if (!sprite) return;
      emitExpr6502(out, stmt.dx, strLab);
      storeTop(out, sprite.dx);
      emitExpr6502(out, stmt.dy, strLab);
      storeTop(out, sprite.dy);
      return;
    }
    case 'sprite':
      out.write(`; place sprite ${stmt.id}`);
      return;
    case 'update':
      emitUpdate6502(out, prog);
      return;
    case 'tone':
      out.write('; tone');
      return;
    case 'cls':
      out.write('; clear');
      return;
    case 'locate':
      out.write('; locate');
      return;
    case 'poke':
      emitExpr6502(out, stmt.value, strLab);
      emitExpr6502(out, stmt.addr, strLab);
      out.inst('jsr DO_POKE');
      return;
    default:
      return;
  }
}

function emitUpdate6502(out: Out, prog: RProg): void {
  for (const sprite of prog.sprites) {
    const skip = out.fresh('MV');
    out.inst(`lda ${vname(sprite.alive)}`);
    out.inst(`ora ${vname(sprite.alive)}+1`);
    out.inst(`beq ${skip}`);
    addVar(out, sprite.x, sprite.dx);
    addVar(out, sprite.y, sprite.dy);
    out.label(skip);
  }
  if (!prog.hit.length) return;
  for (let i = 0; i < prog.sprites.length; i += 1) {
    for (let j = i + 1; j < prog.sprites.length; j += 1) {
      const a = prog.sprites[i];
      const b = prog.sprites[j];
      if (!a || !b) continue;
      const no = out.fresh('NH');
      const ax = vname(a.x);
      const ay = vname(a.y);
      const bx = vname(b.x);
      const by = vname(b.y);
      out.inst(`lda ${vname(a.alive)}`);
      out.inst(`ora ${vname(a.alive)}+1`);
      out.inst(`beq ${no}`);
      out.inst(`lda ${vname(b.alive)}`);
      out.inst(`ora ${vname(b.alive)}+1`);
      out.inst(`beq ${no}`);
      subToE4(out, ax, bx);
      out.inst('jsr SQUARE_C0');
      subToE4(out, ay, by);
      out.inst('jsr SQUARE_ADD');
      halfSum(out, vname(a.size), vname(b.size));
      out.inst('jsr SQUARE_LE');
      out.inst('cmp #1');
      out.inst(`bne ${no}`);
      out.inst('jsr HITBODY');
      out.label(no);
    }
  }
}

function addVar(out: Out, left: string, right: string): void {
  const a = vname(left);
  const b = vname(right);
  out.inst(`clc`);
  out.inst(`lda ${a}`);
  out.inst(`adc ${b}`);
  out.inst(`sta ${a}`);
  out.inst(`lda ${a}+1`);
  out.inst(`adc ${b}+1`);
  out.inst(`sta ${a}+1`);
}

function subToE4(out: Out, left: string, right: string): void {
  out.inst(`sec`);
  out.inst(`lda ${left}`);
  out.inst(`sbc ${right}`);
  out.inst('sta $e4');
  out.inst(`lda ${left}+1`);
  out.inst(`sbc ${right}+1`);
  out.inst('sta $e5');
}

function halfSum(out: Out, left: string, right: string): void {
  out.inst(`lda ${left}`);
  out.inst('lsr');
  out.inst('sta $e4');
  out.inst(`lda ${right}`);
  out.inst('lsr');
  out.inst('clc');
  out.inst('adc $e4');
  out.inst('sta $e4');
  out.inst('lda #0');
  out.inst('sta $e5');
}

const RUNTIME_6502 = `
PUSHAX:
  ldy $e0
  sta $c000,y
  iny
  txa
  sta $c000,y
  iny
  sty $e0
  rts
POPAX:
  ldy $e0
  dey
  lda $c000,y
  tax
  dey
  lda $c000,y
  sty $e0
  rts
PRINT_PTR:
  sta $e2
  stx $e3
  ldy #0
PP_LOOP:
  lda ($e2),y
  beq PP_DONE
  jsr CHROUT
  iny
  bne PP_LOOP
PP_DONE:
  rts
PRINT_S16:
  sta $e4
  stx $e5
  lda $e5
  bpl PS_POS
  lda #45
  jsr CHROUT
  sec
  lda #0
  sbc $e4
  sta $e4
  lda #0
  sbc $e5
  sta $e5
PS_POS:
  lda #0
  sta $ea
PS_DIV:
  jsr DIV10
  pha
  inc $ea
  lda $e4
  ora $e5
  bne PS_DIV
PS_OUT:
  pla
  clc
  adc #48
  jsr CHROUT
  dec $ea
  bne PS_OUT
  rts
DIV10:
  lda #0
  sta $e6
  ldx #16
D10_LOOP:
  asl $e4
  rol $e5
  rol $e6
  lda $e6
  cmp #10
  bcc D10_NEXT
  sbc #10
  sta $e6
  inc $e4
D10_NEXT:
  dex
  bne D10_LOOP
  lda $e6
  rts
OP_ADD:
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  clc
  adc $e4
  tay
  txa
  adc $e5
  tax
  tya
  jmp PUSHAX
OP_SUB:
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  sec
  sbc $e4
  tay
  txa
  sbc $e5
  tax
  tya
  jmp PUSHAX
OP_NEG:
  jsr POPAX
  sta $e4
  stx $e5
  sec
  lda #0
  sbc $e4
  tay
  lda #0
  sbc $e5
  tax
  tya
  jmp PUSHAX
OP_NOT:
  jsr POPAX
  cmp #0
  bne OP_NOT0
  cpx #0
  bne OP_NOT0
  lda #1
  ldx #0
  jmp PUSHAX
OP_NOT0:
  lda #0
  ldx #0
  jmp PUSHAX
OP_AND:
  jsr TRUTH2
  jmp PUSHAX
OP_OR:
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  ora $e4
  tay
  txa
  ora $e5
  tax
  tya
  cmp #0
  bne OP_OR1
  cpx #0
  bne OP_OR1
  jmp PUSHAX
OP_OR1:
  lda #1
  ldx #0
  jmp PUSHAX
TRUTH2:
  jsr POPAX
  cmp #0
  bne T2B
  cpx #0
  bne T2B
  jsr POPAX
  lda #0
  ldx #0
  rts
T2B:
  jsr POPAX
  cmp #0
  bne T2Y
  cpx #0
  bne T2Y
  lda #0
  ldx #0
  rts
T2Y:
  lda #1
  ldx #0
  rts
SCMP:
  sta $e2
  stx $e3
  cpx $e5
  bne SC_HI
  cmp $e4
  bne SC_LO
  lda #0
  rts
SC_LO:
  bcc SC_LT
  lda #1
  rts
SC_HI:
  txa
  eor $e5
  bpl SC_SAME
  txa
  bmi SC_LT
  lda #1
  rts
SC_SAME:
  txa
  cmp $e5
  bcc SC_LT
  lda #1
  rts
SC_LT:
  lda #$ff
  rts
CMP_PUSH:
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  jsr SCMP
  rts
OP_GT:
  jsr CMP_PUSH
  cmp #1
  beq CP1
  lda #0
  ldx #0
  jmp PUSHAX
OP_LT:
  jsr CMP_PUSH
  cmp #$ff
  beq CP1
  lda #0
  ldx #0
  jmp PUSHAX
OP_EQ:
  jsr CMP_PUSH
  cmp #0
  beq CP1
  lda #0
  ldx #0
  jmp PUSHAX
OP_NE:
  jsr CMP_PUSH
  cmp #0
  bne CP1
  lda #0
  ldx #0
  jmp PUSHAX
OP_GE:
  jsr CMP_PUSH
  cmp #$ff
  beq CP0
  lda #1
  ldx #0
  jmp PUSHAX
OP_LE:
  jsr CMP_PUSH
  cmp #1
  beq CP0
CP1:
  lda #1
  ldx #0
  jmp PUSHAX
CP0:
  lda #0
  ldx #0
  jmp PUSHAX
OP_MUL:
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  sta $e2
  stx $e3
  lda $e3
  eor $e5
  sta $e8
  jsr ABS_E2
  jsr ABS_E4
  lda #0
  sta $e6
  sta $e7
  ldx #16
MU_LOOP:
  lsr $e3
  ror $e2
  bcc MU_SHIFT
  clc
  lda $e6
  adc $e4
  sta $e6
  lda $e7
  adc $e5
  sta $e7
MU_SHIFT:
  asl $e4
  rol $e5
  dex
  bne MU_LOOP
  lda $e8
  bpl MU_POS
  sec
  lda #0
  sbc $e6
  sta $e6
  lda #0
  sbc $e7
  sta $e7
MU_POS:
  lda $e6
  ldx $e7
  jmp PUSHAX
ABS_E2:
  lda $e3
  bpl ABS_E2_OK
  sec
  lda #0
  sbc $e2
  sta $e2
  lda #0
  sbc $e3
  sta $e3
ABS_E2_OK:
  rts
ABS_E4:
  lda $e5
  bpl ABS_E4_OK
  sec
  lda #0
  sbc $e4
  sta $e4
  lda #0
  sbc $e5
  sta $e5
ABS_E4_OK:
  rts
OP_DIV:
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  sta $e2
  stx $e3
  lda $e4
  ora $e5
  beq DIV0
  lda $e3
  eor $e5
  sta $e8
  jsr ABS_E2
  jsr ABS_E4
  lda #0
  sta $e6
  sta $e7
  ldx #16
DV_LOOP:
  asl $e2
  rol $e3
  rol $e6
  rol $e7
  sec
  lda $e6
  sbc $e4
  tay
  lda $e7
  sbc $e5
  bcc DV_NO
  sta $e7
  sty $e6
  inc $e2
DV_NO:
  dex
  bne DV_LOOP
  lda $e8
  bpl DV_POS
  sec
  lda #0
  sbc $e2
  sta $e2
  lda #0
  sbc $e3
  sta $e3
DV_POS:
  lda $e2
  ldx $e3
  jmp PUSHAX
DIV0:
  lda #0
  ldx #0
  jmp PUSHAX
OP_MOD:
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  jsr PUSHAX
  lda $e4
  ldx $e5
  jsr PUSHAX
  jsr OP_DIV
  jsr POPAX
  sta $e6
  stx $e7
  jsr POPAX
  sta $e4
  stx $e5
  jsr POPAX
  sta $e2
  stx $e3
  lda $e6
  sta $e4
  lda $e7
  sta $e5
  lda $e2
  ldx $e3
  jsr PUSHAX
  lda $e4
  ldx $e5
  jsr PUSHAX
  jsr OP_MUL
  jsr OP_SUB
  rts
FN_INT:
  rts
FN_ABS:
  jsr POPAX
  sta $e4
  stx $e5
  jsr ABS_E4
  lda $e4
  ldx $e5
  jmp PUSHAX
FN_SGN:
  jsr POPAX
  cmp #0
  bne SG1
  cpx #0
  bne SG1
  jmp PUSHAX
SG1:
  cpx #$80
  bcs SGNEG
  lda #1
  ldx #0
  jmp PUSHAX
SGNEG:
  lda #$ff
  ldx #$ff
  jmp PUSHAX
FN_LEN:
  jsr POPAX
  sta $e2
  stx $e3
  ldy #0
LN_LOOP:
  lda ($e2),y
  beq LN_DONE
  iny
  bne LN_LOOP
LN_DONE:
  tya
  ldx #0
  jmp PUSHAX
FN_PEEK:
  jsr POPAX
  sta $e2
  stx $e3
  ldy #0
  lda ($e2),y
  ldx #0
  jmp PUSHAX
FN_CHR:
  jsr POPAX
  ldy $ec
  sta $c800,y
  lda #0
  iny
  sta $c800,y
  tya
  tax
  dey
  tya
  clc
  adc #2
  sta $ec
  lda $ed
  adc #0
  sta $ed
  lda #<($c800)
  clc
  adc $e4
  pha
  lda #>$c800
  adc #0
  tax
  pla
  jmp PUSHAX
FN_ASC:
  jsr POPAX
  sta $e2
  stx $e3
  ldy #0
  lda ($e2),y
  ldx #0
  jmp PUSHAX
FN_STR:
  lda #0
  ldx #0
  jmp PUSHAX
FN_VAL:
  lda #0
  ldx #0
  jmp PUSHAX
CONCAT:
  jsr POPAX
  sta $f8
  stx $f9
  jsr POPAX
  sta $e2
  stx $e3
  lda $ec
  sta $fa
  lda $ed
  sta $fb
  lda $fa
  ldx $fb
  jsr PUSHAX
  ldy #0
CA_LOOP:
  lda ($e2),y
  beq CA_NEXT
  sta ($fa),y
  iny
  bne CA_LOOP
CA_NEXT:
  sty $e8
  ldy #0
CB_LOOP:
  lda ($f8),y
  sty $e9
  ldy $e8
  sta ($fa),y
  ldy $e9
  cmp #0
  beq CB_DONE
  iny
  inc $e8
  jmp CB_LOOP
CB_DONE:
  inc $e8
  lda $e8
  clc
  adc $ec
  sta $ec
  lda $ed
  adc #0
  sta $ed
  rts
DO_POKE:
  jsr POPAX
  sta $e2
  stx $e3
  jsr POPAX
  ldy #0
  sta ($e2),y
  rts
SQUARE_C0:
  jsr ABS_E4
  lda $e4
  sta $e2
  lda $e5
  sta $e3
  jsr MUL32
  lda $f0
  sta $c0
  lda $f1
  sta $c1
  lda $f2
  sta $c2
  lda $f3
  sta $c3
  rts
SQUARE_ADD:
  jsr ABS_E4
  lda $e4
  sta $e2
  lda $e5
  sta $e3
  jsr MUL32
  clc
  lda $c0
  adc $f0
  sta $c0
  lda $c1
  adc $f1
  sta $c1
  lda $c2
  adc $f2
  sta $c2
  lda $c3
  adc $f3
  sta $c3
  rts
SQUARE_LE:
  jsr ABS_E4
  lda $e4
  sta $e2
  lda $e5
  sta $e3
  jsr MUL32
  lda $c3
  cmp $f3
  bcc SQ_YES
  bne SQ_NO
  lda $c2
  cmp $f2
  bcc SQ_YES
  bne SQ_NO
  lda $c1
  cmp $f1
  bcc SQ_YES
  bne SQ_NO
  lda $c0
  cmp $f0
  bcc SQ_YES
  beq SQ_YES
SQ_NO:
  lda #0
  rts
SQ_YES:
  lda #1
  rts
MUL32:
  lda $e4
  sta $f4
  lda $e5
  sta $f5
  lda #0
  sta $f6
  sta $f7
  sta $f0
  sta $f1
  sta $f2
  sta $f3
  ldx #16
M32_LOOP:
  lsr $e3
  ror $e2
  bcc M32_SHIFT
  clc
  lda $f0
  adc $f4
  sta $f0
  lda $f1
  adc $f5
  sta $f1
  lda $f2
  adc $f6
  sta $f2
  lda $f3
  adc $f7
  sta $f3
M32_SHIFT:
  asl $f4
  rol $f5
  rol $f6
  rol $f7
  dex
  bne M32_LOOP
  rts
`.replace(/^\n/, '');

function emit9900(prog: RProg): string {
  const out = new Out();
  const strings: Array<{ name: string; text: string }> = [];
  const pool = new Map<string, string>();
  const strLab = (text: string): string => {
    const hit = pool.get(text);
    if (hit) return hit;
    const name = `S${pool.size}`;
    pool.set(text, name);
    strings.push({ name, text });
    return name;
  };
  strLab('');
  out.write(`; RETRO-MAGIC TI-99/4A`);
  for (const note of prog.notes) out.write(`; ${note}`);
  out.inst('AORG >A000');
  out.inst('LWPI >8300');
  out.inst('LI R10,>F000');
  out.inst('LI R9,>F800');
  out.inst('LI R0,>E000');
  out.inst('MOV R0,@HEAP');
  out.inst('B @START');
  out.write(RUNTIME_9900);
  for (const fn of prog.fns) {
    out.label(`F_${san(fn.name)}`);
    emitBlock9900(out, prog, fn.body, fn, strLab);
    out.label(`F_${san(fn.name)}_END`);
    out.inst('B *R11');
  }
  if (prog.hit.length) {
    out.label('HITBODY');
    emitBlock9900(out, prog, prog.hit, null, strLab);
    out.inst('B *R11');
  }
  out.label('START');
  emitBlock9900(out, prog, prog.main, null, strLab);
  out.label('HALT');
  out.inst('JMP $');
  out.inst('EVEN');
  out.label('HEAP');
  out.inst('DATA 0');
  for (const item of strings) {
    const bytes = [...item.text].map((ch) => String(ch.charCodeAt(0) & 0xff));
    bytes.push('0');
    out.label(item.name);
    out.inst(`BYTE ${bytes.join(',')}`);
  }
  out.inst('EVEN');
  for (const [name] of collect(prog)) {
    out.label(vname(name));
    out.inst('DATA 0');
  }
  return out.text();
}

function emitBlock9900(out: Out, prog: RProg, list: RStmt[], fn: RFn | null, strLab: (text: string) => string): void {
  for (const stmt of list) emitStmt9900(out, prog, stmt, fn, strLab);
}

function pushImm99(out: Out, value: number): void {
  const word = Math.trunc(value) & 0xffff;
  out.inst(`LI R0,>${word.toString(16).toUpperCase()}`);
  out.inst('DECT R10');
  out.inst('MOV R0,*R10');
}

function pushVar99(out: Out, name: string, _str = false): void {
  out.inst(`MOV @${vname(name)},R0`);
  out.inst('DECT R10');
  out.inst('MOV R0,*R10');
}

function bl(out: Out, label: string): void {
  out.inst('DECT R9');
  out.inst('MOV R11,*R9');
  out.inst(`BL @${label}`);
  out.inst('MOV *R9+,R11');
}

function storeTop99(out: Out, name: string): void {
  out.inst('MOV *R10+,R0');
  out.inst(`MOV R0,@${vname(name)}`);
}

function emitExpr9900(out: Out, expr: RExpr, strLab: (text: string) => string): void {
  switch (expr.t) {
    case 'n':
      pushImm99(out, expr.n);
      return;
    case 's':
      out.inst(`LI R0,${strLab(expr.s)}`);
      out.inst('DECT R10');
      out.inst('MOV R0,*R10');
      return;
    case 'v':
      pushVar99(out, expr.name, expr.str);
      return;
    case 'un':
      emitExpr9900(out, expr.a, strLab);
      bl(out, expr.op === '-' ? 'OP_NEG' : 'OP_NOT');
      return;
    case 'fn':
      if (expr.args[0]) emitExpr9900(out, expr.args[0], strLab);
      else pushImm99(out, 0);
      bl(out, `FN_${expr.name.toUpperCase()}`);
      return;
    case 'bin':
      emitExpr9900(out, expr.a, strLab);
      emitExpr9900(out, expr.b, strLab);
      bl(out, expr.op === '&' ? 'CONCAT' : BIN_9900[expr.op] ?? 'OP_ADD');
      return;
    default:
      pushImm99(out, 0);
  }
}

const BIN_9900: Record<string, string> = {
  '+': 'OP_ADD', '-': 'OP_SUB', '*': 'OP_MUL', '/': 'OP_DIV', '%': 'OP_MOD',
  '==': 'OP_EQ', '=': 'OP_EQ', '!=': 'OP_NE', '<>': 'OP_NE',
  '<': 'OP_LT', '>': 'OP_GT', '<=': 'OP_LE', '>=': 'OP_GE', and: 'OP_AND', or: 'OP_OR',
};

function branchIfZero99(out: Out, label: string): void {
  const skip = out.fresh('NZ');
  out.inst('MOV *R10+,R0');
  out.inst('MOV R0,R0');
  out.inst(`JNE ${skip}`);
  out.inst(`B @${label}`);
  out.label(skip);
}

function branchIfNotZero99(out: Out, label: string): void {
  const skip = out.fresh('NZ');
  out.inst('MOV *R10+,R0');
  out.inst('MOV R0,R0');
  out.inst(`JEQ ${skip}`);
  out.inst(`B @${label}`);
  out.label(skip);
}

function emitStmt9900(out: Out, prog: RProg, stmt: RStmt, fn: RFn | null, strLab: (text: string) => string): void {
  switch (stmt.t) {
    case 'rem':
      out.write(`; ${stmt.text}`);
      return;
    case 'let':
      emitExpr9900(out, stmt.expr, strLab);
      storeTop99(out, stmt.name);
      return;
    case 'print':
    case 'write': {
      const args = stmt.t === 'write' ? [stmt.text] : stmt.args;
      args.forEach((arg, index) => {
        if (stmt.t === 'print' && index) {
          out.inst('LI R0,>0900');
          out.inst('MOVB R0,@>8C00');
        }
        emitExpr9900(out, arg, strLab);
        out.inst('MOV *R10+,R0');
        const isStr = arg.t === 's' || (arg.t === 'v' && arg.str) || (arg.t === 'bin' && arg.op === '&') || (arg.t === 'fn' && (arg.name === 'str' || arg.name === 'chr'));
        bl(out, isStr ? 'PRINTS' : 'PRN');
      });
      if (stmt.t === 'print') {
        out.inst('LI R0,>0D00');
        out.inst('MOVB R0,@>8C00');
      }
      return;
    }
    case 'if': {
      const yes = out.fresh('Y');
      const no = out.fresh('N');
      const end = out.fresh('E');
      emitExpr9900(out, stmt.cond, strLab);
      branchIfNotZero99(out, yes);
      out.inst(`B @${no}`);
      out.label(yes);
      emitBlock9900(out, prog, stmt.yes, fn, strLab);
      out.inst(`B @${end}`);
      out.label(no);
      emitBlock9900(out, prog, stmt.no, fn, strLab);
      out.label(end);
      return;
    }
    case 'while': {
      const start = out.fresh('W');
      const end = out.fresh('WE');
      out.breaks.push(end);
      out.conts.push(start);
      out.label(start);
      emitExpr9900(out, stmt.cond, strLab);
      branchIfZero99(out, end);
      emitBlock9900(out, prog, stmt.body, fn, strLab);
      out.inst(`B @${start}`);
      out.label(end);
      out.breaks.pop();
      out.conts.pop();
      return;
    }
    case 'repeat': {
      const start = out.fresh('R');
      const test = out.fresh('RT');
      const end = out.fresh('RE');
      out.breaks.push(end);
      out.conts.push(test);
      out.label(start);
      emitBlock9900(out, prog, stmt.body, fn, strLab);
      out.label(test);
      emitExpr9900(out, stmt.cond, strLab);
      branchIfZero99(out, start);
      out.label(end);
      out.breaks.pop();
      out.conts.pop();
      return;
    }
    case 'for': {
      const loop = out.fresh('F');
      const cont = out.fresh('FC');
      const end = out.fresh('FE');
      emitExpr9900(out, stmt.from, strLab);
      storeTop99(out, stmt.name);
      out.breaks.push(end);
      out.conts.push(cont);
      out.label(loop);
      pushVar99(out, stmt.name);
      emitExpr9900(out, stmt.to, strLab);
      bl(out, stmt.step.t === 'n' && stmt.step.n < 0 ? 'OP_LT' : 'OP_GT');
      branchIfNotZero99(out, end);
      emitBlock9900(out, prog, stmt.body, fn, strLab);
      out.label(cont);
      pushVar99(out, stmt.name);
      emitExpr9900(out, stmt.step, strLab);
      bl(out, 'OP_ADD');
      storeTop99(out, stmt.name);
      out.inst(`B @${loop}`);
      out.label(end);
      out.breaks.pop();
      out.conts.pop();
      return;
    }
    case 'break':
      out.inst(`B @${out.breaks[out.breaks.length - 1] ?? 'HALT'}`);
      return;
    case 'continue':
      out.inst(`B @${out.conts[out.conts.length - 1] ?? 'HALT'}`);
      return;
    case 'return':
      if (stmt.expr && fn?.ret) {
        emitExpr9900(out, stmt.expr, strLab);
        storeTop99(out, fn.ret.name);
      }
      out.inst(`B @F_${san(fn?.name ?? 'MAIN')}_END`);
      return;
    case 'gosub':
      for (const arg of stmt.args) {
        emitExpr9900(out, arg.expr, strLab);
        storeTop99(out, arg.name);
      }
      bl(out, `F_${san(stmt.fn)}`);
      return;
    case 'motion': {
      const sprite = prog.sprites.find((item) => item.id === stmt.id);
      if (!sprite) return;
      emitExpr9900(out, stmt.dx, strLab);
      storeTop99(out, sprite.dx);
      emitExpr9900(out, stmt.dy, strLab);
      storeTop99(out, sprite.dy);
      return;
    }
    case 'sprite':
      out.write(`; place sprite ${stmt.id}`);
      return;
    case 'update':
      emitUpdate9900(out, prog);
      return;
    case 'tone':
    case 'cls':
    case 'locate':
      out.write(`; ${stmt.t}`);
      return;
    case 'poke':
      emitExpr9900(out, stmt.addr, strLab);
      emitExpr9900(out, stmt.value, strLab);
      out.inst('MOV *R10+,R1');
      out.inst('MOV *R10+,R0');
      out.inst('SWPB R1');
      out.inst('MOVB R1,*R0');
      return;
    default:
      return;
  }
}

function emitUpdate9900(out: Out, prog: RProg): void {
  for (const sprite of prog.sprites) {
    const skip = out.fresh('MV');
    out.inst(`MOV @${vname(sprite.alive)},R0`);
    out.inst('MOV R0,R0');
    out.inst(`JEQ ${skip}`);
    out.inst(`MOV @${vname(sprite.dx)},R1`);
    out.inst(`A R1,@${vname(sprite.x)}`);
    out.inst(`MOV @${vname(sprite.dy)},R1`);
    out.inst(`A R1,@${vname(sprite.y)}`);
    out.label(skip);
  }
  if (!prog.hit.length) return;
  for (let i = 0; i < prog.sprites.length; i += 1) {
    for (let j = i + 1; j < prog.sprites.length; j += 1) {
      const a = prog.sprites[i];
      const b = prog.sprites[j];
      if (!a || !b) continue;
      const no = out.fresh('NH');
      const aliveA = out.fresh('NZ');
      out.inst(`MOV @${vname(a.alive)},R0`);
      out.inst('MOV R0,R0');
      out.inst(`JNE ${aliveA}`);
      out.inst(`B @${no}`);
      out.label(aliveA);
      const aliveB = out.fresh('NZ');
      out.inst(`MOV @${vname(b.alive)},R0`);
      out.inst('MOV R0,R0');
      out.inst(`JNE ${aliveB}`);
      out.inst(`B @${no}`);
      out.label(aliveB);
      out.inst(`MOV @${vname(a.x)},R0`);
      out.inst(`S @${vname(b.x)},R0`);
      bl(out, 'SQUARE');
      out.inst('MOV R2,@SUMHI');
      out.inst('MOV R3,@SUMLO');
      out.inst(`MOV @${vname(a.y)},R0`);
      out.inst(`S @${vname(b.y)},R0`);
      bl(out, 'SQUARE');
      const carry = out.fresh('NC');
      out.inst('A @SUMLO,R3');
      out.inst(`JNC ${carry}`);
      out.inst('INC R2');
      out.label(carry);
      out.inst('A @SUMHI,R2');
      out.inst('MOV R2,@SUMHI');
      out.inst('MOV R3,@SUMLO');
      out.inst(`MOV @${vname(a.size)},R0`);
      out.inst('SRL R0,1');
      out.inst(`MOV @${vname(b.size)},R1`);
      out.inst('SRL R1,1');
      out.inst('A R1,R0');
      bl(out, 'SQUARE');
      const yes = out.fresh('HY');
      const lessHi = out.fresh('HS');
      out.inst('C @SUMHI,R2');
      out.inst(`JLE ${lessHi}`);
      out.inst(`B @${no}`);
      out.label(lessHi);
      out.inst(`JNE ${yes}`);
      out.inst('C @SUMLO,R3');
      out.inst(`JLE ${yes}`);
      out.inst(`B @${no}`);
      out.label(yes);
      bl(out, 'HITBODY');
      out.label(no);
    }
  }
}

const RUNTIME_9900 = `
PRINTS:
  MOV R0,R1
PS1:
  MOVB *R1+,R0
  JEQ PS2
  MOVB R0,@>8C00
  JMP PS1
PS2:
  B *R11
PRN:
  DECT R10
  MOV R11,*R10
  MOV R0,R2
  CI R2,0
  JEQ PR0
  JLT PRNEG
  JMP PRPOS
PR0:
  LI R0,>3000
  MOVB R0,@>8C00
  JMP PRDONE
PRNEG:
  LI R0,>2D00
  MOVB R0,@>8C00
  NEG R2
PRPOS:
  CLR R8
  LI R3,10000
  BL @PDIG
  LI R3,1000
  BL @PDIG
  LI R3,100
  BL @PDIG
  LI R3,10
  BL @PDIG
  LI R3,1
  BL @PDIG
PRDONE:
  MOV *R10+,R11
  B *R11
PDIG:
  CLR R5
PDG:
  C R2,R3
  JLT PDD
  S R3,R2
  INC R5
  JMP PDG
PDD:
  MOV R8,R8
  JNE PDO
  MOV R5,R5
  JEQ PDRET
  LI R8,1
PDO:
  AI R5,>0030
  SWPB R5
  MOVB R5,@>8C00
PDRET:
  B *R11
OP_ADD:
  MOV *R10+,R1
  MOV *R10+,R0
  A R1,R0
  DECT R10
  MOV R0,*R10
  B *R11
OP_SUB:
  MOV *R10+,R1
  MOV *R10+,R0
  S R1,R0
  DECT R10
  MOV R0,*R10
  B *R11
OP_NEG:
  MOV *R10+,R0
  NEG R0
  DECT R10
  MOV R0,*R10
  B *R11
OP_NOT:
  MOV *R10+,R0
  MOV R0,R0
  JEQ ON1
  CLR R0
  JMP ONP
ON1:
  LI R0,1
ONP:
  DECT R10
  MOV R0,*R10
  B *R11
OP_GT:
  MOV *R10+,R1
  MOV *R10+,R0
  C R0,R1
  JGT OGY
  CLR R0
  JMP OGP
OGY:
  LI R0,1
OGP:
  DECT R10
  MOV R0,*R10
  B *R11
OP_LT:
  MOV *R10+,R1
  MOV *R10+,R0
  C R0,R1
  JLT OGY
  CLR R0
  JMP OGP
OP_EQ:
  MOV *R10+,R1
  MOV *R10+,R0
  C R0,R1
  JEQ OGY
  CLR R0
  JMP OGP
OP_NE:
  MOV *R10+,R1
  MOV *R10+,R0
  C R0,R1
  JNE OGY
  CLR R0
  JMP OGP
OP_GE:
  MOV *R10+,R1
  MOV *R10+,R0
  C R0,R1
  JLT OG0
  LI R0,1
  JMP OGP
OG0:
  CLR R0
  JMP OGP
OP_LE:
  MOV *R10+,R1
  MOV *R10+,R0
  C R0,R1
  JGT OG0
  LI R0,1
  JMP OGP
OP_AND:
  MOV *R10+,R1
  MOV *R10+,R0
  MOV R0,R0
  JEQ OG0
  MOV R1,R1
  JEQ OG0
  LI R0,1
  JMP OGP
OP_OR:
  MOV *R10+,R1
  MOV *R10+,R0
  MOV R0,R0
  JNE OGY
  MOV R1,R1
  JNE OGY
  JMP OG0
OP_MUL:
  MOV *R10+,R1
  MOV *R10+,R0
  CLR R4
  MOV R0,R0
  JGT MU0
  JEQ MU0
  NEG R0
  INC R4
MU0:
  MOV R1,R1
  JGT MU1
  JEQ MU1
  NEG R1
  MOV R4,R4
  JEQ MU1S
  CLR R4
  JMP MU1
MU1S:
  LI R4,1
MU1:
  MOV R1,R2
  MPY R2,R0
  MOV R4,R4
  JEQ MU2
  NEG R1
MU2:
  MOV R1,R0
  DECT R10
  MOV R0,*R10
  B *R11
OP_DIV:
  MOV *R10+,R1
  MOV *R10+,R0
  MOV R1,R1
  JEQ DVZ
  CLR R4
  MOV R0,R0
  JGT DV0
  JEQ DV0
  NEG R0
  INC R4
DV0:
  MOV R1,R1
  JGT DV1
  JEQ DV1
  NEG R1
  MOV R4,R4
  JEQ DV1S
  CLR R4
  JMP DV1
DV1S:
  LI R4,1
DV1:
  CLR R2
  MOV R0,R3
  DIV R1,R2
  MOV R4,R4
  JEQ DV2
  NEG R2
DV2:
  MOV R2,R0
  DECT R10
  MOV R0,*R10
  B *R11
DVZ:
  CLR R0
  DECT R10
  MOV R0,*R10
  B *R11
OP_MOD:
  MOV *R10+,R1
  MOV *R10+,R0
  MOV R1,R1
  JEQ MDZ
  MOV R0,R4
  ABS R0
  ABS R1
  CLR R2
  MOV R0,R3
  DIV R1,R2
  MOV R3,R0
  MOV R4,R4
  JGT MDP
  JEQ MDP
  NEG R0
MDP:
  DECT R10
  MOV R0,*R10
  B *R11
MDZ:
  CLR R0
  DECT R10
  MOV R0,*R10
  B *R11
FN_INT:
  B *R11
FN_ABS:
  MOV *R10,R0
  ABS R0
  MOV R0,*R10
  B *R11
FN_LEN:
  MOV *R10+,R1
  CLR R0
FL:
  MOVB *R1+,R2
  JEQ FLD
  INC R0
  JMP FL
FLD:
  DECT R10
  MOV R0,*R10
  B *R11
FN_PEEK:
  MOV *R10+,R1
  MOVB *R1,R0
  SRL R0,8
  DECT R10
  MOV R0,*R10
  B *R11
FN_SGN:
  MOV *R10+,R0
  MOV R0,R0
  JEQ SGP
  JLT SGN
  LI R0,1
  JMP SGP
SGN:
  LI R0,>FFFF
SGP:
  DECT R10
  MOV R0,*R10
  B *R11
FN_CHR:
  CLR R0
  DECT R10
  MOV R0,*R10
  B *R11
FN_ASC:
  MOV *R10+,R1
  MOVB *R1,R0
  SRL R0,8
  DECT R10
  MOV R0,*R10
  B *R11
FN_STR:
  CLR R0
  DECT R10
  MOV R0,*R10
  B *R11
FN_VAL:
  CLR R0
  DECT R10
  MOV R0,*R10
  B *R11
CONCAT:
  MOV *R10+,R1
  MOV *R10+,R2
  MOV @HEAP,R3
  MOV R3,R0
  DECT R10
  MOV R0,*R10
C1:
  MOVB *R2+,R0
  JEQ C2
  MOVB R0,*R3+
  JMP C1
C2:
  MOVB *R1+,R0
  MOVB R0,*R3+
  JNE C2
  MOV R3,@HEAP
  B *R11
SQUARE:
  DECT R10
  MOV R11,*R10
  ABS R0
  MOV R0,R1
  CLR R2
  CLR R3
  LI R4,16
SQL:
  SRL R1,1
  JNC SQN
  A R0,R3
  JNC SQN
  INC R2
SQN:
  SLA R0,1
  DEC R4
  JNE SQL
  MOV *R10+,R11
  B *R11
SUMHI:
  DATA 0
SUMLO:
  DATA 0
`.replace(/^\n/, '');
