/**
 * Retro program to a BASIC listing.
 * C64 is BASIC 2. Apple II is Applesoft. TI-99/4A sprite programs are Extended BASIC.
 * Apple plots emoji in lo-res because the machine has no sprite chip.
 */

import { c64Sprite, tiHex } from './glyph.js';
import type { RExpr, RFn, RProg, RSprite, RStmt } from './ir.js';

const RESERVED = new Set(['IF', 'ON', 'OR', 'TO', 'FN', 'GO', 'TI', 'ST', 'AT', 'GR', 'DO', 'NEXT', 'Z8', 'Z9']);

export function emitBasic(prog: RProg): string {
  resetBasicLabels();
  const man = mangler(prog.target);
  const out = new Lines();
  const machine = prog.target === 'c64' ? 'Commodore 64 BASIC 2' : prog.target === 'apple2' ? 'Applesoft BASIC' : 'TI Extended BASIC';
  out.line(`REM RETRO-MAGIC ${machine}`);
  for (const note of prog.notes) out.line(`REM ${note}`);
  if (prog.target === 'apple2' && prog.sprites.length) {
    out.line('REM APPLE II HAS NO SPRITE CHIP. EMOJI ARE LO-RES SOFTWARE SPRITES.');
  }
  if (prog.target === 'ti99' && prog.sprites.length) {
    out.line('REM SPRITES NEED TI EXTENDED BASIC.');
  }
  const names = collectNames(prog);
  for (const name of names) {
    man(name.name, name.str);
  }
  for (const [from, to] of man.map) {
    out.line(`REM ${from}=${to}`);
  }

  if (prog.target === 'c64') {
    out.line('POKE 53280,14: POKE 53281,6');
    out.line('PRINT CHR$(147)');
  } else if (prog.target === 'apple2') {
    if (prog.sprites.length) out.line('GR');
    else out.line('HOME');
  } else {
    out.line('CALL CLEAR');
    out.line('CALL SCREEN(5)');
    if (prog.sprites.length) out.line('CALL MAGNIFY(2)');
  }

  for (const sprite of prog.sprites) emitSpriteSetup(prog, sprite, man, out);

  emitBlock(prog, prog.main, man, out, null);
  out.line('END');

  if (prog.hit.length) {
    out.label('hit');
    emitBlock(prog, prog.hit, man, out, null);
    out.line('RETURN');
  }
  for (const fn of prog.fns) {
    out.label(fn.name);
    emitBlock(prog, fn.body, man, out, fn);
    out.label(`${fn.name}_end`);
    out.line('RETURN');
  }
  for (const sprite of prog.sprites) {
    if (prog.target !== 'apple2') continue;
    emitAppleDraw(prog, sprite, man, out, false);
    emitAppleDraw(prog, sprite, man, out, true);
  }
  for (const sprite of prog.sprites) {
    if (prog.target !== 'c64') continue;
    const bytes = c64Sprite(sprite.bits);
    let chunk: string[] = [];
    const flush = (): void => {
      if (!chunk.length) return;
      out.line(`DATA ${chunk.join(',')}`);
      chunk = [];
    };
    for (const byte of bytes) {
      chunk.push(String(byte));
      if (chunk.length === 8) flush();
    }
    flush();
  }
  return `${out.render()}\n`;
}

class Lines {
  readonly pieces: Array<{ label?: string; text: string }> = [];

  line(text: string): void {
    this.pieces.push({ text });
  }

  label(name: string): void {
    this.pieces.push({ label: name, text: `REM ${name}` });
  }

  render(): string {
    const at = new Map<string, number>();
    let n = 10;
    for (const piece of this.pieces) {
      if (piece.label) at.set(piece.label, n);
      n += 10;
    }
    n = 10;
    return this.pieces.map((piece) => {
      const text = piece.text.replace(/@([A-Za-z_][A-Za-z0-9_]*)@/g, (_, label: string) => {
        const line = at.get(label);
        if (!line) throw new Error(`missing BASIC label ${label}`);
        return String(line);
      });
      const row = `${n} ${text}`;
      n += 10;
      return row;
    }).join('\n');
  }
}

function mangler(target: RProg['target']): { (name: string, str: boolean): string; map: Map<string, string> } {
  const map = new Map<string, string>();
  let n = 0;
  const fn = (name: string, str: boolean): string => {
    const key = `${str ? '$' : ''}${name}`;
    const hit = map.get(key);
    if (hit) return hit;
    let out = '';
    if (target === 'ti99') {
      let base = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!base || !/[A-Z]/.test(base[0] ?? '')) base = `V${base}`;
      base = (base || 'V').slice(0, 10);
      if (RESERVED.has(base)) base = `V${base}`.slice(0, 10);
      out = `${base}${str ? '$' : ''}`;
      let i = 2;
      while ([...map.values()].includes(out)) {
        out = `${base.slice(0, 8)}${i}${str ? '$' : ''}`;
        i += 1;
      }
    } else {
      for (;;) {
        const word = `${String.fromCharCode(65 + (n % 26))}${Math.floor(n / 26) % 10}`;
        n += 1;
        if (RESERVED.has(word)) continue;
        out = `${word}${str ? '$' : ''}`;
        break;
      }
    }
    map.set(key, out);
    return out;
  };
  return Object.assign(fn, { map });
}

function collectNames(prog: RProg): Array<{ name: string; str: boolean }> {
  const found: Array<{ name: string; str: boolean }> = [];
  const seen = new Set<string>();
  const add = (name: string, str: boolean): void => {
    const key = `${str}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name, str });
  };
  const expr = (node: RExpr | null | undefined): void => {
    if (!node) return;
    if (node.t === 'v') add(node.name, node.str);
    if (node.t === 'bin') {
      expr(node.a);
      expr(node.b);
    }
    if (node.t === 'un' || node.t === 'fn') node.t === 'un' ? expr(node.a) : node.args.forEach(expr);
  };
  const stmts = (list: RStmt[]): void => {
    for (const stmt of list) {
      if (stmt.t === 'let') {
        add(stmt.name, stmt.str);
        expr(stmt.expr);
      }
      if (stmt.t === 'print') stmt.args.forEach(expr);
      if (stmt.t === 'if') {
        expr(stmt.cond);
        stmts(stmt.yes);
        stmts(stmt.no);
      }
      if (stmt.t === 'for') {
        add(stmt.name, false);
        expr(stmt.from);
        expr(stmt.to);
        expr(stmt.step);
        stmts(stmt.body);
      }
      if (stmt.t === 'while') {
        expr(stmt.cond);
        stmts(stmt.body);
      }
      if (stmt.t === 'repeat') {
        stmts(stmt.body);
        expr(stmt.cond);
      }
      if (stmt.t === 'gosub') {
        for (const arg of stmt.args) {
          add(arg.name, arg.str);
          expr(arg.expr);
        }
        if (stmt.ret) add(stmt.ret.name, stmt.ret.str);
      }
      if (stmt.t === 'return') expr(stmt.expr);
      if (stmt.t === 'motion') {
        expr(stmt.dx);
        expr(stmt.dy);
      }
      if (stmt.t === 'tone') {
        expr(stmt.freq);
        expr(stmt.ms);
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
    for (const param of fn.params) add(param.name, param.str);
    if (fn.ret) add(fn.ret.name, fn.ret.str);
    stmts(fn.body);
  }
  for (const sprite of prog.sprites) {
    add(sprite.x, false);
    add(sprite.y, false);
    add(sprite.dx, false);
    add(sprite.dy, false);
    add(sprite.size, false);
    add(sprite.alive, false);
  }
  return found;
}

function emitBlock(prog: RProg, list: RStmt[], man: (name: string, str: boolean) => string, out: Lines, fn: RFn | null): void {
  for (const stmt of list) emitStmt(prog, stmt, man, out, fn);
}

function emitStmt(prog: RProg, stmt: RStmt, man: (name: string, str: boolean) => string, out: Lines, fn: RFn | null): void {
  const ex = (node: RExpr): string => emitExpr(prog, node, man);
  switch (stmt.t) {
    case 'rem':
      out.line(`REM ${stmt.text}`);
      return;
    case 'let':
      out.line(`${man(stmt.name, stmt.str)}=${ex(stmt.expr)}`);
      return;
    case 'print':
      if (!stmt.args.length) out.line('PRINT');
      else out.line(`PRINT ${stmt.args.map((arg) => ex(arg)).join(';CHR$(9);')}`);
      return;
    case 'if':
      emitIf(prog, stmt.cond, stmt.yes, stmt.no, man, out, fn);
      return;
    case 'for':
      emitFor(prog, stmt, man, out, fn);
      return;
    case 'while': {
      const start = outId();
      const end = outId();
      out.label(start);
      out.line(`IF (${ex(stmt.cond)})=0 THEN GOTO @${end}@`);
      emitBlock(prog, stmt.body, man, out, fn);
      out.line(`GOTO @${start}@`);
      out.label(end);
      return;
    }
    case 'repeat': {
      const start = outId();
      out.label(start);
      emitBlock(prog, stmt.body, man, out, fn);
      out.line(`IF (${ex(stmt.cond)})=0 THEN GOTO @${start}@`);
      return;
    }
    case 'break':
      out.line(`GOTO @${breakLabel}@`);
      return;
    case 'continue':
      out.line(`GOTO @${continueLabel}@`);
      return;
    case 'return':
      if (stmt.expr && fn?.ret) out.line(`${man(fn.ret.name, fn.ret.str)}=${ex(stmt.expr)}`);
      if (fn) out.line(`GOTO @${fn.name}_end@`);
      else out.line('RETURN');
      return;
    case 'gosub':
      for (const arg of stmt.args) out.line(`${man(arg.name, arg.str)}=${ex(arg.expr)}`);
      out.line(`GOSUB @${stmt.fn}@`);
      return;
    case 'sprite': {
      const sprite = prog.sprites.find((item) => item.id === stmt.id);
      if (sprite) emitSpritePlace(prog, sprite, man, out, false);
      return;
    }
    case 'motion': {
      const sprite = prog.sprites.find((item) => item.id === stmt.id);
      if (!sprite) return;
      out.line(`${man(sprite.dx, false)}=${ex(stmt.dx)}`);
      out.line(`${man(sprite.dy, false)}=${ex(stmt.dy)}`);
      return;
    }
    case 'update':
      emitUpdate(prog, man, out);
      return;
    case 'tone':
      emitTone(prog, ex(stmt.freq), ex(stmt.ms), stmt.kind, out);
      return;
    case 'cls':
      out.line(prog.target === 'c64' ? 'PRINT CHR$(147)' : prog.target === 'apple2' ? 'HOME' : 'CALL CLEAR');
      return;
    case 'locate':
      emitLocate(prog, ex(stmt.col), ex(stmt.row), out);
      return;
    case 'write':
      out.line(`PRINT ${ex(stmt.text)};`);
      return;
    case 'poke':
      if (prog.target === 'ti99') out.line(`CALL LOAD(${ex(stmt.addr)},${ex(stmt.value)})`);
      else out.line(`POKE ${ex(stmt.addr)},${ex(stmt.value)}`);
      return;
    default:
      return;
  }
}

let breakLabel = '';
let continueLabel = '';
let labelN = 0;

function outId(): string {
  labelN += 1;
  return `L${labelN}`;
}

function emitIf(prog: RProg, cond: RExpr, yes: RStmt[], no: RStmt[], man: (name: string, str: boolean) => string, out: Lines, fn: RFn | null): void {
  const ex = (node: RExpr): string => emitExpr(prog, node, man);
  if (!no.length) {
    const end = outId();
    out.line(`IF (${ex(cond)})=0 THEN GOTO @${end}@`);
    emitBlock(prog, yes, man, out, fn);
    out.label(end);
    return;
  }
  const yesAt = outId();
  const noAt = outId();
  const end = outId();
  out.line(`IF (${ex(cond)})<>0 THEN GOTO @${yesAt}@`);
  out.line(`GOTO @${noAt}@`);
  out.label(yesAt);
  emitBlock(prog, yes, man, out, fn);
  out.line(`GOTO @${end}@`);
  out.label(noAt);
  emitBlock(prog, no, man, out, fn);
  out.label(end);
}

function emitFor(prog: RProg, stmt: Extract<RStmt, { t: 'for' }>, man: (name: string, str: boolean) => string, out: Lines, fn: RFn | null): void {
  const name = man(stmt.name, false);
  const after = outId();
  const next = outId();
  const prevBreak = breakLabel;
  const prevContinue = continueLabel;
  breakLabel = after;
  continueLabel = next;
  out.line(`FOR ${name}=${emitExpr(prog, stmt.from, man)} TO ${emitExpr(prog, stmt.to, man)} STEP ${emitExpr(prog, stmt.step, man)}`);
  emitBlock(prog, stmt.body, man, out, fn);
  out.label(next);
  out.line(`NEXT ${name}`);
  out.label(after);
  breakLabel = prevBreak;
  continueLabel = prevContinue;
}

function emitUpdate(prog: RProg, man: (name: string, str: boolean) => string, out: Lines): void {
  for (const sprite of prog.sprites) {
    const x = man(sprite.x, false);
    const y = man(sprite.y, false);
    const dx = man(sprite.dx, false);
    const dy = man(sprite.dy, false);
    const alive = man(sprite.alive, false);
    if (prog.target === 'apple2') emitSpritePlace(prog, sprite, man, out, true);
    out.line(`IF ${alive}<>0 THEN ${x}=${x}+${dx}`);
    out.line(`IF ${alive}<>0 THEN ${y}=${y}+${dy}`);
    emitSpritePlace(prog, sprite, man, out, false);
  }
  if (!prog.hit.length) return;
  for (let i = 0; i < prog.sprites.length; i += 1) {
    for (let j = i + 1; j < prog.sprites.length; j += 1) {
      const a = prog.sprites[i];
      const b = prog.sprites[j];
      if (!a || !b) continue;
      const ax = man(a.x, false);
      const ay = man(a.y, false);
      const bx = man(b.x, false);
      const by = man(b.y, false);
      const as = man(a.size, false);
      const bs = man(b.size, false);
      out.line(`IF ${man(a.alive, false)}<>0 THEN IF ${man(b.alive, false)}<>0 THEN IF (${ax}-${bx})*(${ax}-${bx})+(${ay}-${by})*(${ay}-${by})<=(${as}/2+${bs}/2)*(${as}/2+${bs}/2) THEN GOSUB @hit@`);
    }
  }
}

function emitSpriteSetup(prog: RProg, sprite: RSprite, _man: (name: string, str: boolean) => string, out: Lines): void {
  if (prog.target === 'c64') {
    const base = 14336 + sprite.id * 64;
    out.line(`FOR I=0 TO 63: READ B: POKE ${base}+I,B: NEXT`);
    out.line(`POKE ${2040 + sprite.id},${base / 64}`);
    out.line(`POKE ${53287 + sprite.id},${sprite.color & 15}`);
    out.line(`POKE 53269,PEEK(53269) OR ${1 << sprite.id}`);
    return;
  }
  if (prog.target === 'ti99') {
    const code = 96 + sprite.id;
    out.line(`CALL CHAR(${code},"${tiHex(sprite.bits)}")`);
  }
}

function emitSpritePlace(prog: RProg, sprite: RSprite, man: (name: string, str: boolean) => string, out: Lines, erase: boolean): void {
  const x = man(sprite.x, false);
  const y = man(sprite.y, false);
  if (prog.target === 'c64') {
    out.line(`Z9=${x}+24`);
    out.line(`POKE ${53248 + sprite.id * 2},Z9-INT(Z9/256)*256`);
    out.line(`IF Z9>=256 THEN POKE 53264,PEEK(53264) OR ${1 << sprite.id}`);
    out.line(`IF Z9<256 THEN POKE 53264,PEEK(53264) AND ${255 - (1 << sprite.id)}`);
    out.line(`POKE ${53249 + sprite.id * 2},${y}+50`);
    return;
  }
  if (prog.target === 'ti99') {
    const code = 96 + sprite.id;
    const color = (sprite.color % 15) + 1;
    if (!erase) {
      out.line(`CALL SPRITE(#${sprite.id + 1},${code},${color},${y}+1,${x}+1)`);
    }
    return;
  }
  out.line(`Z8=${sprite.color}`);
  out.line(`GOSUB @${erase ? `erase${sprite.id}` : `draw${sprite.id}`}@`);
}

function emitAppleDraw(prog: RProg, sprite: RSprite, man: (name: string, str: boolean) => string, out: Lines, erase: boolean): void {
  out.label(erase ? `erase${sprite.id}` : `draw${sprite.id}`);
  out.line(erase ? 'COLOR=0' : `COLOR=${sprite.color & 15}`);
  const x = man(sprite.x, false);
  const y = man(sprite.y, false);
  out.line(`Z9=INT(${x}*39/${Math.max(1, prog.width)})`);
  out.line(`Z8=INT(${y}*47/${Math.max(1, prog.height)})`);
  sprite.bits.forEach((row, py) => {
    for (let px = 0; px < 8; px += 1) {
      if (((row >> (7 - px)) & 1) === 0) continue;
      out.line(`IF Z9+${px}>=0 THEN IF Z9+${px}<=39 THEN IF Z8+${py}>=0 THEN IF Z8+${py}<=47 THEN PLOT Z9+${px},Z8+${py}`);
    }
  });
  out.line('RETURN');
}

function emitTone(prog: RProg, freq: string, ms: string, kind: 'tone' | 'noise', out: Lines): void {
  if (prog.target === 'ti99') {
    out.line(kind === 'noise' ? `CALL SOUND(${ms},-5,2)` : `CALL SOUND(${ms},${freq},2)`);
    return;
  }
  if (prog.target === 'apple2') {
    out.line(`FOR Z9=1 TO ${ms}: S=PEEK(-16336): NEXT`);
    return;
  }
  out.line('POKE 54296,15: POKE 54277,64: POKE 54278,128');
  if (kind === 'noise') out.line('POKE 54276,129');
  else {
    out.line(`POKE 54273,INT((${freq})*16.404/256)`);
    out.line(`POKE 54272,(${freq})*16.404-INT((${freq})*16.404/256)*256`);
    out.line('POKE 54276,17');
  }
  out.line(`FOR Z9=1 TO ${ms}: NEXT`);
  out.line('POKE 54276,16');
}

function emitLocate(prog: RProg, col: string, row: string, out: Lines): void {
  if (prog.target === 'c64') out.line(`POKE 781,${col}: POKE 782,${row}: POKE 783,0: SYS 65520`);
  else if (prog.target === 'apple2') out.line(`HTAB (${col})+1: VTAB (${row})+1`);
  else out.line(`CALL HCHAR((${row})+1,(${col})+1,32)`);
}

function emitExpr(prog: RProg, node: RExpr, man: (name: string, str: boolean) => string): string {
  switch (node.t) {
    case 'n':
      return Number.isInteger(node.n) ? String(node.n) : String(Number(node.n.toFixed(6)));
    case 's':
      return quoteBasic(prog, node.s);
    case 'v':
      return man(node.name, node.str);
    case 'un':
      return node.op === '-' ? `-(${emitExpr(prog, node.a, man)})` : `((${emitExpr(prog, node.a, man)})=0)`;
    case 'fn': {
      const arg = node.args[0] ? emitExpr(prog, node.args[0], man) : '0';
      if (node.name === 'int') return `(SGN(${arg})*INT(ABS(${arg})))`;
      if (node.name === 'abs') return `ABS(${arg})`;
      if (node.name === 'len') return `LEN(${arg})`;
      if (node.name === 'str') return `STR$(${arg})`;
      if (node.name === 'val') return `VAL(${arg})`;
      if (node.name === 'chr') return `CHR$(${arg})`;
      if (node.name === 'asc') return `ASC(${arg}+CHR$(0))`;
      if (node.name === 'sgn') return `SGN(${arg})`;
      if (node.name === 'peek') return `PEEK(${arg})`;
      return '0';
    }
    case 'bin': {
      const a = emitExpr(prog, node.a, man);
      const b = emitExpr(prog, node.b, man);
      if (node.op === '&') return prog.target === 'ti99' ? `(${a})&(${b})` : `(${a})+(${b})`;
      if (node.op === 'and') return `((${a})<>0)*((${b})<>0)`;
      if (node.op === 'or') return `((((${a})<>0)+((${b})<>0))<>0)`;
      if (node.op === '==' || node.op === '=') return `((${a})=(${b}))`;
      if (node.op === '!=' || node.op === '<>') return `((${a})<>(${b}))`;
      if (node.op === '%') return `((${a})-INT((${a})/(${b}))*(${b}))`;
      return `((${a})${node.op}(${b}))`;
    }
    default:
      return '0';
  }
}

function quoteBasic(prog: RProg, text: string): string {
  if (!text) return '""';
  const parts: string[] = [];
  let plain = '';
  const flush = (): void => {
    if (!plain) return;
    parts.push(`"${plain.replace(/"/g, '')}"`);
    plain = '';
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 126 || ch === '"') {
      flush();
      parts.push(`CHR$(${code > 255 ? 42 : code})`);
    } else plain += ch;
  }
  flush();
  if (!parts.length) return '""';
  return parts.join(prog.target === 'ti99' ? '&' : '+');
}

/** Reset label counters. Tests compile more than one program in one process. */
export function resetBasicLabels(): void {
  labelN = 0;
  breakLabel = '';
  continueLabel = '';
}
