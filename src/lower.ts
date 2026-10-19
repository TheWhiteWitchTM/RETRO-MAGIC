/**
 * MAGIC to the retro program.
 * `@c64`, `@apple2`, and `@ti99` keep a statement on that machine.
 * `@target("c64")` picks the machine when the command line does not.
 * `@3d` is refused. These machines do not host that engine.
 */

import { MagicError, Parser } from 'magic';
import { RetroError } from './error.js';
import { glyphFor, MACHINE, type TargetName } from './glyph.js';
import type { RExpr, RFn, RProg, RStmt } from './ir.js';

interface Ann {
  name: string;
  args: Ast[];
  called: boolean;
  alias: string | null;
  line: number;
  column: number;
}

interface Ast {
  kind: string;
  line: number;
  column: number;
  annotations?: Ann[];
  [key: string]: unknown;
}

type Value =
  | { k: 'n'; n: number }
  | { k: 's'; s: string }
  | { k: 'bool'; v: boolean }
  | { k: 'nil' }
  | { k: 'slot'; name: string; str: boolean }
  | { k: 'expr'; expr: RExpr; str: boolean }
  | { k: 'list'; items: Value[] }
  | { k: 'rec'; fields: Map<string, Value> }
  | { k: 'hex'; q: number; r: number }
  | { k: 'sprite'; id: number }
  | { k: 'engine' }
  | { k: 'terminal' }
  | { k: 'score'; value: string; best: string }
  | { k: 'stage'; update: Ast | null; draw: Ast | null }
  | { k: 'loop'; fn: Ast }
  | { k: 'fn'; node: Ast; name: string }
  | { k: 'ctor'; mod: string; name: string }
  | { k: 'ns'; mod: string }
  | { k: 'app' }
  | { k: 'desktop' }
  | { k: 'win'; title: string; x: number; y: number; w: number; h: number; labels: Array<{ text: string; x: number; y: number }> }
  | { k: 'label'; text: string; x: number; y: number };

const DIR_Q = [1, 1, 0, -1, -1, 0];
const DIR_R = [0, -1, -1, 0, 1, 1];
const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const MODULE_EXPORTS: Record<string, string[]> = {
  canvas: ['Canvas', 'Engine', 'Utilities'],
  terminal: ['Terminal', 'Utilities'],
  '2d': ['Canvas', 'Terminal', 'Engine', 'Utilities'],
  ui: ['Application', 'Window', 'Label', 'Button', 'Desktop'],
  sound: ['Sound', 'tone', 'note', 'noise', 'play', 'freq'],
  hex: ['Hex', 'Grid', 'hex', 'neighbor', 'neighbors', 'distance', 'ring', 'spiral', 'line', 'toPixel', 'fromPixel', 'add', 'round', 'key', 'parse', 'DIRECTIONS'],
  games: ['clamp', 'lerp', 'approach', 'choice', 'chance', 'range', 'wrap', 'Clock', 'Keys', 'Loop', 'Stage', 'Score'],
};

function modName(spec: string): string | null {
  const name = spec.replace(/^emoji-engine-/, '').replace(/^magic\//, '');
  if (name === '3d' || spec === 'emoji-engine-3d') return '3d';
  if (MODULE_EXPORTS[name] || name === '3d') return name;
  if (name === 'emoji-engine-2d') return '2d';
  return null;
}

export function targetOfFile(source: string, filename = ''): TargetName | null {
  try {
    const program = new Parser(filename).parse(source) as unknown as Ast;
    const anns = [...((program.annotations as Ann[] | undefined) ?? [])];
    for (const stmt of (program.body as Ast[] | undefined) ?? []) anns.push(...(stmt.annotations ?? []));
    for (const ann of anns) {
      if (ann.name !== 'target') continue;
      const arg = ann.args[0];
      if (arg && arg.kind === 'string') {
        const value = String(arg.value);
        if (value === 'c64' || value === 'apple2' || value === 'ti99') return value;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function lowerMagic(source: string, filename: string, target: TargetName): RProg {
  let program: Ast;
  try {
    program = new Parser(filename).parse(source) as unknown as Ast;
  } catch (error) {
    if (error instanceof MagicError) {
      throw new RetroError(error.message, error.line, error.column, error.filename || filename);
    }
    throw error;
  }
  return new Lowerer(program, filename, target).run();
}

class Lowerer {
  private readonly scope = new Map<string, Value>();
  private readonly stack: Map<string, Value>[] = [];
  private blocks: RStmt[][] = [];
  private fnPrefix = '';
  private temps = 0;
  private fns: RFn[] = [];
  private lowered = new Set<string>();
  private readonly pending = new Map<string, Ast>();
  private nameHint = '';
  private warned = new Set<string>();
  private readonly prog: RProg;

  constructor(private readonly program: Ast, filename: string, private readonly target: TargetName) {
    const machine = MACHINE[target];
    this.prog = {
      target,
      filename,
      main: [],
      fns: this.fns,
      sprites: [],
      hit: [],
      warnings: [],
      width: machine.pixelWidth,
      height: machine.pixelHeight,
      cols: machine.cols,
      rows: machine.rows,
      notes: [],
    };
    this.blocks = [this.prog.main];
  }

  run(): RProg {
    this.bindBuiltins();
    for (const stmt of (this.program.body as Ast[]) ?? []) {
      if (stmt.kind === 'fn') this.pending.set(String(stmt.name), stmt);
    }
    for (const stmt of (this.program.body as Ast[]) ?? []) this.statement(stmt);
    for (const [name, node] of this.pending) {
      if (!this.lowered.has(name)) this.lowerFunction(name, node, []);
    }
    return this.prog;
  }

  private bindBuiltins(): void {
    for (const name of ['len', 'str', 'num', 'int', 'abs', 'type', 'time', 'chr', 'asc', 'sgn', 'val', 'peek', 'poke']) {
      this.scope.set(name, { k: 'ctor', mod: 'builtin', name });
    }
  }

  private fail(node: { line?: number; column?: number }, message: string): never {
    throw new RetroError(message, node.line ?? 1, node.column ?? 1, this.prog.filename);
  }

  private warn(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.prog.warnings.push(message);
  }

  private note(message: string): void {
    if (this.prog.notes.includes(message)) return;
    this.prog.notes.push(message);
  }

  private fresh(prefix: string): string {
    this.temps += 1;
    return `${prefix}${this.temps}`;
  }

  private emit(stmt: RStmt): void {
    this.blocks[this.blocks.length - 1]?.push(stmt);
  }

  private capture(run: () => void): RStmt[] {
    const list: RStmt[] = [];
    this.blocks.push(list);
    try {
      run();
    } finally {
      this.blocks.pop();
    }
    return list;
  }

  private pushScope(): void {
    this.stack.push(new Map(this.scope));
  }

  private popScope(): void {
    const prev = this.stack.pop();
    if (!prev) return;
    this.scope.clear();
    for (const [key, value] of prev) this.scope.set(key, value);
  }

  private allows(stmt: Ast): boolean {
    const only = (stmt.annotations ?? []).filter((ann) =>
      (ann.name === 'c64' || ann.name === 'apple2' || ann.name === 'ti99') && !ann.called);
    if (only.length === 0) return true;
    return only.some((ann) => ann.name === this.target);
  }

  private statement(stmt: Ast): void {
    if (!stmt || stmt.kind === 'import') {
      if (stmt) this.importStmt(stmt);
      return;
    }
    if (!this.allows(stmt)) return;
    switch (stmt.kind) {
      case 'fn':
        this.scope.set(String(stmt.name), { k: 'fn', node: stmt, name: String(stmt.name) });
        return;
      case 'let':
        this.letStmt(stmt);
        return;
      case 'assign':
        this.assignStmt(stmt);
        return;
      case 'print':
        this.printStmt(stmt);
        return;
      case 'if':
        this.ifStmt(stmt);
        return;
      case 'while':
        this.whileStmt(stmt);
        return;
      case 'repeat':
        this.repeatStmt(stmt);
        return;
      case 'for':
        this.forStmt(stmt);
        return;
      case 'break':
        this.emit({ t: 'break' });
        return;
      case 'continue':
        this.emit({ t: 'continue' });
        return;
      case 'return':
        this.emit({ t: 'return', expr: stmt.value ? this.toExpr(this.value(stmt.value as Ast)) : null });
        return;
      case 'expr':
        this.value(stmt.expr as Ast);
        return;
      case 'class':
        this.fail(stmt, 'classes are not on these machines. Use functions, records, and sprites.');
        return;
      case 'try':
      case 'throw':
        this.fail(stmt, 'try and throw are not on these machines.');
        return;
      default:
        this.fail(stmt, `${stmt.kind} is not on these machines.`);
    }
  }

  private importStmt(stmt: Ast): void {
    const spec = String(stmt.specifier ?? '');
    const mod = modName(spec);
    if (spec.startsWith('.') || spec.startsWith('/')) {
      this.fail(stmt, 'a second Magic file is not linked yet. Keep the script in one file.');
    }
    if (mod === '3d') {
      this.fail(stmt, '3d does not fit the C64, the Apple II, or the TI-99/4A. Drop @3d.');
    }
    if (!mod) this.fail(stmt, `unknown module ${spec}`);
    if (mod === 'ui') this.note('ui is text boxes: Window and Label. Other widgets become labels.');
    const form = String(stmt.form ?? '');
    if (form === 'namespace' && stmt.alias) {
      this.scope.set(String(stmt.alias), { k: 'ns', mod });
      return;
    }
    const names = (stmt.names as Array<{ imported: string; local: string }> | undefined) ?? [];
    for (const item of names) this.bindExport(item.local, mod, item.imported);
  }

  private bindExport(local: string, mod: string, imported: string): void {
    if (mod === 'hex' && imported === 'DIRECTIONS') {
      const items: Value[] = DIR_Q.map((q, i) => ({ k: 'hex', q, r: DIR_R[i] ?? 0 }));
      this.scope.set(local, { k: 'list', items });
      return;
    }
    this.scope.set(local, { k: 'ctor', mod, name: imported });
  }

  private letStmt(stmt: Ast): void {
    const name = String(stmt.name);
    if (!stmt.init) {
      const slot = this.local(name);
      this.emit({ t: 'let', name: slot, str: false, expr: { t: 'n', n: 0 } });
      this.scope.set(name, { k: 'slot', name: slot, str: false });
      return;
    }
    this.nameHint = name;
    const init = this.value(stmt.init as Ast);
    this.nameHint = '';
    if (init.k === 'sprite' || init.k === 'engine' || init.k === 'terminal' || init.k === 'score' || init.k === 'stage' || init.k === 'loop' || init.k === 'fn' || init.k === 'app' || init.k === 'win' || init.k === 'list' || init.k === 'rec' || init.k === 'hex' || init.k === 'ns' || init.k === 'ctor' || init.k === 'desktop' || init.k === 'label') {
      if (init.k === 'sprite') {
        const sprite = this.prog.sprites[init.id];
        if (sprite) sprite.label = name;
      }
      this.scope.set(name, init);
      return;
    }
    const str = this.isStr(init);
    const slot = this.local(name);
    this.emit({ t: 'let', name: slot, str, expr: this.toExpr(init) });
    this.scope.set(name, { k: 'slot', name: slot, str });
  }

  private local(name: string): string {
    return this.fnPrefix ? `${this.fnPrefix}${name}` : name;
  }

  private assignStmt(stmt: Ast): void {
    const target = stmt.target as Ast;
    const op = String(stmt.op ?? '=');
    const raw = this.value(stmt.value as Ast);
    if (target.kind === 'name') {
      const name = String(target.name);
      const prev = this.lookup(name);
      const base: Value = prev?.k === 'slot' ? prev : { k: 'slot', name: this.local(name), str: this.isStr(raw) };
      const expr = op === '=' ? this.toExpr(raw) : this.compound(this.toExpr(base), op, this.toExpr(raw));
      const str = this.isStr(raw) || (prev?.k === 'slot' && prev.str);
      const slot = prev?.k === 'slot' ? prev.name : this.local(name);
      this.emit({ t: 'let', name: slot, str, expr });
      this.scope.set(name, { k: 'slot', name: slot, str });
      return;
    }
    if (target.kind === 'member') {
      const obj = this.value(target.object as Ast);
      const field = String(target.name);
      const slot = this.fieldSlot(obj, field, target);
      if (!slot) this.fail(target, `cannot assign ${field} on these machines`);
      const expr = op === '=' ? this.toExpr(raw) : this.compound({ t: 'v', name: slot, str: false }, op, this.toExpr(raw));
      this.emit({ t: 'let', name: slot, str: false, expr });
      return;
    }
    this.fail(target, 'this assignment is not on these machines');
  }

  private compound(left: RExpr, op: string, right: RExpr): RExpr {
    const bin = op === '+=' ? '+' : op === '-=' ? '-' : op === '*=' ? '*' : '/';
    return { t: 'bin', op: bin, a: left, b: right };
  }

  private printStmt(stmt: Ast): void {
    const args = ((stmt.args as Ast[]) ?? []).map((arg) => this.printExpr(this.value(arg)));
    this.emit({ t: 'print', args });
  }

  private printExpr(value: Value): RExpr {
    if (value.k === 'bool') return { t: 's', s: value.v ? 'true' : 'false' };
    if (value.k === 'nil') return { t: 's', s: '' };
    if (value.k === 'hex') return { t: 's', s: `${value.q},${value.r}` };
    return this.toExpr(value);
  }

  private ifStmt(stmt: Ast): void {
    const arms = (stmt.arms as Ast[]) ?? [];
    const parts = arms.map((arm) => ({
      cond: this.toExpr(this.value(arm.test as Ast)),
      yes: this.capture(() => this.block(arm.body as Ast[])),
    }));
    let acc = this.capture(() => this.block((stmt.elseBody as Ast[] | null) ?? []));
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (!part) continue;
      acc = [{ t: 'if', cond: part.cond, yes: part.yes, no: acc }];
    }
    for (const stmt of acc) this.emit(stmt);
  }

  private whileStmt(stmt: Ast): void {
    const setup: RStmt[] = [];
    this.blocks.push(setup);
    const cond = this.toExpr(this.value(stmt.test as Ast));
    this.blocks.pop();
    const body = this.capture(() => this.block(stmt.body as Ast[]));
    for (const item of setup) this.emit(item);
    this.emit({ t: 'while', cond, body: [...body, ...setup] });
  }

  private repeatStmt(stmt: Ast): void {
    const body = this.capture(() => this.block(stmt.body as Ast[]));
    const extra: RStmt[] = [];
    this.blocks.push(extra);
    const cond = this.toExpr(this.value(stmt.test as Ast));
    this.blocks.pop();
    this.emit({ t: 'repeat', body: [...body, ...extra], cond });
  }

  private forStmt(stmt: Ast): void {
    if (stmt.iter) {
      this.forIn(stmt);
      return;
    }
    const from = this.toExpr(this.value(stmt.from as Ast));
    const to = this.toExpr(this.value(stmt.to as Ast));
    const step = stmt.step ? this.toExpr(this.value(stmt.step as Ast)) : { t: 'n' as const, n: 1 };
    const name = String(stmt.name);
    const slot = this.local(name);
    this.pushScope();
    this.scope.set(name, { k: 'slot', name: slot, str: false });
    const body = this.capture(() => this.block(stmt.body as Ast[]));
    this.popScope();
    this.emit({ t: 'for', name: slot, from, to, step, body });
  }

  private forIn(stmt: Ast): void {
    const list = this.value(stmt.iter as Ast);
    if (list.k !== 'list') this.fail(stmt, 'for-in needs a list the compiler can see');
    const name = String(stmt.name);
    for (const item of list.items) {
      this.pushScope();
      this.scope.set(name, item);
      this.block(stmt.body as Ast[]);
      this.popScope();
    }
  }

  private block(list: Ast[] | undefined): void {
    for (const stmt of list ?? []) this.statement(stmt);
  }

  private value(node: Ast): Value {
    switch (node.kind) {
      case 'number':
        return { k: 'n', n: Number(node.value) };
      case 'string':
        return { k: 's', s: String(node.value) };
      case 'bool':
        return { k: 'bool', v: Boolean(node.value) };
      case 'nil':
        return { k: 'nil' };
      case 'name':
        return this.nameValue(node, String(node.name));
      case 'list':
        return { k: 'list', items: ((node.items as Ast[]) ?? []).map((item) => this.value(item)) };
      case 'record':
        return this.recordValue(node);
      case 'unary':
        return this.unaryValue(node);
      case 'binary':
        return this.binaryValue(node);
      case 'template':
        return this.templateValue(node);
      case 'member':
        return this.memberValue(node);
      case 'index':
        return this.indexValue(node);
      case 'call':
        return this.callValue(node.callee as Ast, (node.args as Ast[]) ?? [], node);
      case 'new':
        return this.construct(this.value(node.callee as Ast), (node.args as Ast[]) ?? [], node);
      case 'fn':
        return this.fnExpr(node);
      case 'await':
      case 'self':
      case 'super':
        this.fail(node, `${node.kind} is not on these machines`);
        return { k: 'nil' };
      default:
        this.fail(node, `${node.kind} is not on these machines`);
        return { k: 'nil' };
    }
  }

  private nameValue(node: Ast, name: string): Value {
    const found = this.lookup(name);
    if (found) return found;
    this.fail(node, `${name} is not defined on these machines`);
    return { k: 'nil' };
  }

  private lookup(name: string): Value | undefined {
    if (this.scope.has(name)) return this.scope.get(name);
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const hit = this.stack[i]?.get(name);
      if (hit) return hit;
    }
    return undefined;
  }

  private recordValue(node: Ast): Value {
    const fields = new Map<string, Value>();
    for (const field of (node.fields as Array<{ name: string; value: Ast }>) ?? []) {
      fields.set(field.name, this.value(field.value));
    }
    return { k: 'rec', fields };
  }

  private fnExpr(node: Ast): Value {
    const name = this.fresh('__fn');
    this.pending.set(name, node);
    return { k: 'fn', node, name };
  }

  private unaryValue(node: Ast): Value {
    const inner = this.value(node.expr as Ast);
    const op = String(node.op);
    if (inner.k === 'n' && op === '-') return { k: 'n', n: -inner.n };
    if ((inner.k === 'n' || inner.k === 'bool' || inner.k === 'nil') && op === 'not') {
      return { k: 'bool', v: !truth(inner) };
    }
    if (op === 'not') return { k: 'expr', expr: { t: 'un', op: 'not', a: this.toExpr(inner) }, str: false };
    if (op === '-') return { k: 'expr', expr: { t: 'un', op: '-', a: this.toExpr(inner) }, str: false };
    if (op === '#') return this.lenOf(inner, node);
    this.fail(node, `${op} is not on these machines`);
    return { k: 'nil' };
  }

  private binaryValue(node: Ast): Value {
    const left = this.value(node.left as Ast);
    const right = this.value(node.right as Ast);
    const op = String(node.op);
    if (op === '&') {
      if (left.k === 's' && right.k === 's') return { k: 's', s: left.s + right.s };
      if ((left.k === 's' || left.k === 'n') && (right.k === 's' || right.k === 'n')) {
        return { k: 's', s: textOf(left) + textOf(right) };
      }
      return { k: 'expr', expr: { t: 'bin', op: '&', a: this.toExpr(left), b: this.toExpr(right) }, str: true };
    }
    const ln = numOf(left);
    const rn = numOf(right);
    if (ln !== null && rn !== null && op !== 'and' && op !== 'or') {
      const folded = foldNum(op, ln, rn);
      if (folded !== null) return typeof folded === 'boolean' ? { k: 'bool', v: folded } : { k: 'n', n: folded };
    }
    if (op === 'and') {
      if (isConst(left) && isConst(right)) return { k: 'bool', v: truth(left) && truth(right) };
      return { k: 'expr', expr: { t: 'bin', op: 'and', a: this.toExpr(left), b: this.toExpr(right) }, str: false };
    }
    if (op === 'or') {
      if (isConst(left) && isConst(right)) return { k: 'bool', v: truth(left) || truth(right) };
      return { k: 'expr', expr: { t: 'bin', op: 'or', a: this.toExpr(left), b: this.toExpr(right) }, str: false };
    }
    return { k: 'expr', expr: { t: 'bin', op, a: this.toExpr(left), b: this.toExpr(right) }, str: false };
  }

  private templateValue(node: Ast): Value {
    let text = '';
    let dynamic: RExpr | null = null;
    for (const part of (node.parts as Array<{ text?: string; expr?: Ast }>) ?? []) {
      if (part.text !== undefined) {
        if (dynamic) dynamic = { t: 'bin', op: '&', a: dynamic, b: { t: 's', s: part.text } };
        else text += part.text;
        continue;
      }
      if (!part.expr) continue;
      const bit = this.value(part.expr);
      if (!dynamic && (bit.k === 's' || bit.k === 'n' || bit.k === 'bool' || bit.k === 'nil')) {
        text += textOf(bit);
        continue;
      }
      const expr = this.toExpr(bit);
      dynamic = dynamic ? { t: 'bin', op: '&', a: dynamic, b: expr } : { t: 'bin', op: '&', a: { t: 's', s: text }, b: expr };
      text = '';
    }
    if (!dynamic) return { k: 's', s: text };
    if (text) dynamic = { t: 'bin', op: '&', a: dynamic, b: { t: 's', s: text } };
    return { k: 'expr', expr: dynamic, str: true };
  }

  private memberValue(node: Ast): Value {
    const obj = this.value(node.object as Ast);
    const field = String(node.name);
    if (obj.k === 'ns') return { k: 'ctor', mod: obj.mod, name: field };
    if (obj.k === 'rec') return obj.fields.get(field) ?? { k: 'nil' };
    if (obj.k === 'hex') {
      if (field === 'q') return { k: 'n', n: obj.q };
      if (field === 'r') return { k: 'n', n: obj.r };
      if (field === 's') return { k: 'n', n: -obj.q - obj.r };
    }
    if (obj.k === 'score') {
      if (field === 'value' || field === 'best') return { k: 'slot', name: field === 'value' ? obj.value : obj.best, str: false };
    }
    if (obj.k === 'app' && field === 'desktop') return { k: 'desktop' };
    if (obj.k === 'sprite' || obj.k === 'slot' || obj.k === 'expr') {
      const slot = this.fieldSlot(obj, field, node);
      if (slot) return { k: 'slot', name: slot, str: false };
    }
    this.fail(node, `${field} is not on these machines`);
    return { k: 'nil' };
  }

  private fieldSlot(obj: Value, field: string, node: Ast): string | null {
    if (obj.k === 'sprite') {
      const sprite = this.prog.sprites[obj.id];
      if (!sprite) return null;
      if (field === 'x') return sprite.x;
      if (field === 'y') return sprite.y;
      if (field === 'vx' || field === 'dx') return sprite.dx;
      if (field === 'vy' || field === 'dy') return sprite.dy;
      if (field === 'size') return sprite.size;
      if (field === 'alive') return sprite.alive;
      if (field === 'emoji') return null;
    }
    if (obj.k === 'score') {
      if (field === 'value') return obj.value;
      if (field === 'best') return obj.best;
    }
    if (field === 'x' || field === 'y' || field === 'alive') this.fail(node, `${field} needs a sprite`);
    return null;
  }

  private indexValue(node: Ast): Value {
    const obj = this.value(node.object as Ast);
    const index = this.value(node.index as Ast);
    const at = numOf(index);
    if (obj.k === 'list' && at !== null) return obj.items[Math.trunc(at)] ?? { k: 'nil' };
    if (obj.k === 's' && at !== null) return { k: 's', s: [...obj.s][Math.trunc(at)] ?? '' };
    this.fail(node, 'this index is not on these machines');
    return { k: 'nil' };
  }

  private callValue(callee: Ast, args: Ast[], node: Ast): Value {
    if (callee.kind === 'member') {
      const obj = this.value(callee.object as Ast);
      return this.callMethod(obj, String(callee.name), args, node);
    }
    const fn = this.value(callee);
    if (fn.k === 'ctor') return this.callCtor(fn, args, node);
    if (fn.k === 'fn') return this.callFn(fn, args, node);
    this.fail(node, 'this call is not on these machines');
    return { k: 'nil' };
  }

  private callCtor(fn: Value & { k: 'ctor' }, args: Ast[], node: Ast): Value {
    if (fn.mod === 'builtin') return this.builtin(fn.name, args, node);
    if (fn.mod === 'hex') return this.hexCall(fn.name, args, node);
    if (fn.mod === 'games') return this.gamesCall(fn.name, args, node);
    if (fn.mod === 'sound') return this.soundCall(fn.name, args, node);
    if (fn.mod === 'canvas' || fn.mod === 'terminal' || fn.mod === '2d' || fn.mod === 'ui') {
      return this.construct(fn, args, node);
    }
    this.fail(node, `${fn.name} is not on these machines`);
    return { k: 'nil' };
  }

  private builtin(name: string, args: Ast[], node: Ast): Value {
    const values = args.map((arg) => this.value(arg));
    if (name === 'len') return this.lenOf(values[0] ?? { k: 'nil' }, node);
    if (name === 'int') return this.fnNum('int', values[0], (n) => Math.trunc(n));
    if (name === 'abs') return this.fnNum('abs', values[0], (n) => Math.abs(n));
    if (name === 'sgn') return this.fnNum('sgn', values[0], (n) => (n < 0 ? -1 : n > 0 ? 1 : 0));
    if (name === 'num' || name === 'val') return this.fnNum('val', values[0], (n) => n);
    if (name === 'str') {
      const v = values[0] ?? { k: 'nil' };
      if (isConst(v)) return { k: 's', s: textOf(v) };
      return { k: 'expr', expr: { t: 'fn', name: 'str', args: [this.toExpr(v)] }, str: true };
    }
    if (name === 'chr') return this.fnText('chr', values[0]);
    if (name === 'asc') {
      const v = values[0];
      if (v?.k === 's') return { k: 'n', n: v.s.codePointAt(0) ?? 0 };
      if (v) return { k: 'expr', expr: { t: 'fn', name: 'asc', args: [this.toExpr(v)] }, str: false };
    }
    if (name === 'time') return { k: 'n', n: 0 };
    if (name === 'type') return { k: 's', s: typeName(values[0] ?? { k: 'nil' }) };
    if (name === 'peek') {
      const v = values[0];
      if (!v) return { k: 'n', n: 0 };
      return { k: 'expr', expr: { t: 'fn', name: 'peek', args: [this.toExpr(v)] }, str: false };
    }
    if (name === 'poke') {
      const addr = values[0];
      const val = values[1];
      if (addr && val) this.emit({ t: 'poke', addr: this.toExpr(addr), value: this.toExpr(val) });
      return { k: 'nil' };
    }
    this.fail(node, `${name} is not on these machines`);
    return { k: 'nil' };
  }

  private fnNum(name: 'int' | 'abs' | 'sgn' | 'val', value: Value | undefined, fold: (n: number) => number): Value {
    if (!value) return { k: 'n', n: 0 };
    const n = numOf(value);
    if (n !== null) return { k: 'n', n: fold(n) };
    return { k: 'expr', expr: { t: 'fn', name, args: [this.toExpr(value)] }, str: false };
  }

  private fnText(name: 'chr', value: Value | undefined): Value {
    if (!value) return { k: 's', s: '' };
    const n = numOf(value);
    if (n !== null) return { k: 's', s: String.fromCharCode(Math.trunc(n) & 0xff) };
    return { k: 'expr', expr: { t: 'fn', name, args: [this.toExpr(value)] }, str: true };
  }

  private lenOf(value: Value, node: Ast): Value {
    if (value.k === 's') return { k: 'n', n: [...value.s].length };
    if (value.k === 'list') return { k: 'n', n: value.items.length };
    if (value.k === 'rec') return { k: 'n', n: value.fields.size };
    if (value.k === 'slot' && value.str) {
      return { k: 'expr', expr: { t: 'fn', name: 'len', args: [{ t: 'v', name: value.name, str: true }] }, str: false };
    }
    if (value.k === 'expr' && value.str) {
      return { k: 'expr', expr: { t: 'fn', name: 'len', args: [value.expr] }, str: false };
    }
    this.fail(node, 'len needs text or a list the compiler can see');
    return { k: 'nil' };
  }

  private hexCall(name: string, args: Ast[], node: Ast): Value {
    const values = args.map((arg) => this.value(arg));
    if (name === 'hex' || name === 'Hex') return this.makeHex(values, node);
    if (name === 'distance' && values[0]?.k === 'hex' && values[1]?.k === 'hex') {
      return { k: 'n', n: hexDistance(values[0], values[1]) };
    }
    if (name === 'neighbor' && values[0]?.k === 'hex' && numOf(values[1] ?? { k: 'nil' }) !== null) {
      return neighbor(values[0], numOf(values[1] ?? { k: 'nil' }) ?? 0);
    }
    if (name === 'neighbors' && values[0]?.k === 'hex') {
      return { k: 'list', items: [0, 1, 2, 3, 4, 5].map((dir) => neighbor(values[0] as Value & { k: 'hex' }, dir)) };
    }
    if (name === 'ring' && values[0]?.k === 'hex' && numOf(values[1] ?? { k: 'nil' }) !== null) {
      return { k: 'list', items: ring(values[0], numOf(values[1] ?? { k: 'nil' }) ?? 0) };
    }
    if (name === 'spiral' && values[0]?.k === 'hex' && numOf(values[1] ?? { k: 'nil' }) !== null) {
      return { k: 'list', items: spiral(values[0], numOf(values[1] ?? { k: 'nil' }) ?? 0) };
    }
    if (name === 'toPixel' && values[0]?.k === 'hex' && numOf(values[1] ?? { k: 'nil' }) !== null) {
      const size = numOf(values[1] ?? { k: 'nil' }) ?? 0;
      const pixel = toPixel(values[0].q, values[0].r, size);
      return { k: 'rec', fields: new Map<string, Value>([['x', { k: 'n', n: pixel.x }], ['y', { k: 'n', n: pixel.y }]]) };
    }
    if (name === 'key' && values[0]?.k === 'hex') return { k: 's', s: `${values[0].q},${values[0].r}` };
    if (name === 'add' && values[0]?.k === 'hex' && values[1]?.k === 'hex') {
      return { k: 'hex', q: values[0].q + values[1].q, r: values[0].r + values[1].r };
    }
    if (name === 'line' && values[0]?.k === 'hex' && values[1]?.k === 'hex') {
      const n = hexDistance(values[0], values[1]);
      const items: Value[] = [];
      for (let i = 0; i <= n; i += 1) {
        const t = n === 0 ? 0 : i / n;
        items.push(roundHex(values[0].q + (values[1].q - values[0].q) * t + 1e-6, values[0].r + (values[1].r - values[0].r) * t + 1e-6));
      }
      return { k: 'list', items };
    }
    this.fail(node, `${name} needs hex cells the compiler can see`);
    return { k: 'nil' };
  }

  private makeHex(values: Value[], node: Ast): Value {
    const q = numOf(values[0] ?? { k: 'nil' });
    const r = numOf(values[1] ?? { k: 'nil' });
    if (q === null || r === null) this.fail(node, 'hex needs numbers');
    return { k: 'hex', q: q ?? 0, r: r ?? 0 };
  }

  private gamesCall(name: string, args: Ast[], node: Ast): Value {
    const values = args.map((arg) => this.value(arg));
    const nums = values.map((value) => numOf(value));
    if (name === 'clamp' && nums[0] !== null && nums[1] !== null && nums[2] !== null) {
      return { k: 'n', n: Math.min(nums[2] ?? 0, Math.max(nums[1] ?? 0, nums[0] ?? 0)) };
    }
    if (name === 'lerp' && nums[0] !== null && nums[1] !== null && nums[2] !== null) {
      return { k: 'n', n: (nums[0] ?? 0) + ((nums[1] ?? 0) - (nums[0] ?? 0)) * (nums[2] ?? 0) };
    }
    if (name === 'approach' && nums[0] !== null && nums[1] !== null && nums[2] !== null) {
      return { k: 'n', n: approach(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0) };
    }
    if (name === 'wrap' && nums[0] !== null && nums[1] !== null) {
      return { k: 'n', n: wrap(nums[0] ?? 0, nums[1] ?? 0) };
    }
    if (name === 'range') {
      const count = nums[0];
      const start = nums[1] ?? 0;
      if (count === null) this.fail(node, 'range needs a count the compiler can see');
      const items: Value[] = [];
      for (let i = 0; i < Math.max(0, Math.trunc(count ?? 0)); i += 1) items.push({ k: 'n', n: start + i });
      return { k: 'list', items };
    }
    if (name === 'choice') {
      const list = values[0];
      if (list?.k === 'list') return list.items[0] ?? { k: 'nil' };
    }
    if (name === 'chance') return { k: 'bool', v: false };
    if (name === 'Clock' || name === 'Keys' || name === 'Loop' || name === 'Stage' || name === 'Score') {
      return this.construct({ k: 'ctor', mod: 'games', name }, args, node);
    }
    this.fail(node, `${name} needs numbers the compiler can see`);
    return { k: 'nil' };
  }

  private soundCall(name: string, args: Ast[], node: Ast): Value {
    if (name === 'Sound') return { k: 'ns', mod: 'sound' };
    if (name === 'freq') {
      const note = this.value(args[0] ?? node);
      if (note.k !== 's') this.fail(node, 'freq needs a note name');
      return { k: 'n', n: freqOf(note.s, node, (where, message) => this.fail(where, message)) };
    }
    if (name === 'tone' || name === 'note' || name === 'noise' || name === 'play') {
      return this.playSound(name, args, node);
    }
    this.fail(node, `${name} is not on these machines`);
    return { k: 'nil' };
  }

  private playSound(name: string, args: Ast[], node: Ast): Value {
    if (name === 'play') {
      const song = this.value(args[0] ?? node);
      if (song.k !== 's') this.fail(node, 'play needs text');
      let last: Value = { k: 'nil' };
      for (const part of song.s.split(/\s+/).filter(Boolean)) {
        if (part === 'rest') continue;
        const [noteName, msText] = part.split('/');
        last = this.emitNote(noteName || 'C4', msText ? Number(msText) : 200, node, (where, message) => this.fail(where, message));
      }
      return last;
    }
    if (name === 'noise') {
      const ms = numOf(this.value(args[0] ?? node)) ?? 80;
      this.emit({ t: 'tone', freq: { t: 'n', n: 0 }, ms: { t: 'n', n: ms }, kind: 'noise' });
      return { k: 'rec', fields: new Map<string, Value>([['ms', { k: 'n', n: ms }], ['frequency', { k: 'n', n: 0 }]]) };
    }
    if (name === 'tone') {
      const freq = this.toExpr(this.value(args[0] ?? node));
      const ms = args[1] ? this.toExpr(this.value(args[1])) : { t: 'n' as const, n: 200 };
      this.emit({ t: 'tone', freq, ms, kind: 'tone' });
      const freqN = freq.t === 'n' ? freq.n : null;
      const msN = ms.t === 'n' ? ms.n : null;
      if (freqN !== null && msN !== null) {
        return { k: 'rec', fields: new Map<string, Value>([['frequency', { k: 'n', n: freqN }], ['ms', { k: 'n', n: msN }]]) };
      }
      return { k: 'nil' };
    }
    const note = this.value(args[0] ?? node);
    const ms = args[1] ? this.value(args[1]) : { k: 'n' as const, n: 200 };
    if (note.k !== 's') this.fail(node, 'note needs a name like A4');
    return this.emitNote(note.s, numOf(ms) ?? 200, node, (where, message) => this.fail(where, message));
  }

  private emitNote(name: string, ms: number, node: Ast, fail: (where: Ast, message: string) => never): Value {
    const frequency = freqOf(name, node, fail);
    this.emit({ t: 'tone', freq: { t: 'n', n: frequency }, ms: { t: 'n', n: ms }, kind: 'tone' });
    return {
      k: 'rec',
      fields: new Map<string, Value>([
        ['frequency', { k: 'n', n: frequency }],
        ['ms', { k: 'n', n: ms }],
        ['note', { k: 's', s: name }],
      ]),
    };
  }

  private construct(ctor: Value, args: Ast[], node: Ast): Value {
    if (ctor.k !== 'ctor') {
      if (ctor.k === 'fn') return this.callFn(ctor, args, node);
      this.fail(node, 'this constructor is not on these machines');
    }
    const name = ctor.name;
    const values = args.map((arg) => this.value(arg));
    if (name === 'Engine') return this.newEngine(values);
    if (name === 'Terminal') return this.newTerminal(values);
    if (name === 'Score') return this.newScore(values);
    if (name === 'Stage') return { k: 'stage', update: null, draw: null };
    if (name === 'Loop') {
      const fn = values[0];
      if (fn?.k !== 'fn') this.fail(node, 'Loop needs a function');
      return { k: 'loop', fn: fn.node };
    }
    if (name === 'Hex' || name === 'hex') return this.makeHex(values, node);
    if (name === 'Grid') {
      const radius = Math.max(0, Math.trunc(numOf(values[0] ?? { k: 'n', n: 1 }) ?? 1));
      return { k: 'list', items: spiral({ q: 0, r: 0 }, radius) };
    }
    if (name === 'Application') return { k: 'app' };
    if (name === 'Window') return this.newWindow(values);
    if (name === 'Label' || name === 'Button' || name === 'StaticText') return this.newLabel(values);
    if (name === 'Sound') return { k: 'ns', mod: 'sound' };
    if (name === 'Clock' || name === 'Keys') return { k: 'rec', fields: new Map() };
    if (name === 'Canvas') return { k: 'engine' };
    this.fail(node, `${name} is not on these machines`);
    return { k: 'nil' };
  }

  private newEngine(values: Value[]): Value {
    const rec = values[0];
    if (rec?.k === 'rec') {
      const width = numOf(rec.fields.get('width') ?? { k: 'nil' });
      const height = numOf(rec.fields.get('height') ?? { k: 'nil' });
      if (width) this.prog.width = width;
      if (height) this.prog.height = height;
    }
    if (this.target === 'apple2') {
      this.warn('Apple II has no sprite chip. Emoji sprites are plotted as lo-res software sprites.');
    }
    return { k: 'engine' };
  }

  private newTerminal(values: Value[]): Value {
    const rec = values[0];
    if (rec?.k === 'rec') {
      const cols = numOf(rec.fields.get('cols') ?? { k: 'nil' });
      const rows = numOf(rec.fields.get('rows') ?? { k: 'nil' });
      const machine = MACHINE[this.target];
      if (cols) {
        this.prog.cols = Math.min(machine.cols, Math.max(1, Math.trunc(cols)));
        if (cols > machine.cols) this.warn(`${this.target} text is ${machine.cols} columns. ${cols} was clamped.`);
      }
      if (rows) {
        this.prog.rows = Math.min(machine.rows, Math.max(1, Math.trunc(rows)));
        if (rows > machine.rows) this.warn(`${this.target} text is ${machine.rows} rows. ${rows} was clamped.`);
      }
    }
    return { k: 'terminal' };
  }

  private newScore(values: Value[]): Value {
    const start = numOf(values[0] ?? { k: 'n', n: 0 }) ?? 0;
    const base = this.nameHint || this.fresh('score');
    const value = `${base}.value`;
    const best = `${base}.best`;
    this.emit({ t: 'let', name: value, str: false, expr: { t: 'n', n: start } });
    this.emit({ t: 'let', name: best, str: false, expr: { t: 'n', n: start } });
    return { k: 'score', value, best };
  }

  private newWindow(values: Value[]): Value {
    const rec = values[0];
    const fields = rec?.k === 'rec' ? rec.fields : new Map<string, Value>();
    const title = fields.get('title')?.k === 's' ? fields.get('title') : null;
    return {
      k: 'win',
      title: title && title.k === 's' ? title.s : 'Window',
      x: numOf(fields.get('x') ?? { k: 'n', n: 0 }) ?? 0,
      y: numOf(fields.get('y') ?? { k: 'n', n: 0 }) ?? 0,
      w: numOf(fields.get('w') ?? { k: 'n', n: 20 }) ?? 20,
      h: numOf(fields.get('h') ?? { k: 'n', n: 8 }) ?? 8,
      labels: [],
    };
  }

  private newLabel(values: Value[]): Value {
    const rec = values[0];
    const fields = rec?.k === 'rec' ? rec.fields : new Map<string, Value>();
    const text = fields.get('text');
    return {
      k: 'label',
      text: text?.k === 's' ? text.s : 'Ok',
      x: numOf(fields.get('x') ?? { k: 'n', n: 1 }) ?? 1,
      y: numOf(fields.get('y') ?? { k: 'n', n: 1 }) ?? 1,
    };
  }

  private callMethod(obj: Value, name: string, args: Ast[], node: Ast): Value {
    const values = () => args.map((arg) => this.value(arg));
    if (obj.k === 'engine') return this.engineMethod(name, values(), node);
    if (obj.k === 'terminal') return this.terminalMethod(name, values(), node);
    if (obj.k === 'score' && name === 'add') return this.scoreAdd(obj, values()[0] ?? { k: 'n', n: 0 });
    if (obj.k === 'score' && name === 'reset') {
      this.emit({ t: 'let', name: obj.value, str: false, expr: { t: 'n', n: 0 } });
      return { k: 'n', n: 0 };
    }
    if (obj.k === 'stage' && name === 'go') return this.stageGo(obj, values()[0], node);
    if (obj.k === 'stage' && name === 'update') return this.stageUpdate(obj, values()[0]);
    if (obj.k === 'stage' && name === 'draw') return { k: 'nil' };
    if (obj.k === 'loop' && name === 'run') return this.loopRun(obj, values());
    if (obj.k === 'ns' && obj.mod === 'sound') return this.soundCall(name, args, node);
    if (obj.k === 'desktop' && name === 'add') return this.desktopAdd(values()[0]);
    if (obj.k === 'win' && name === 'add') return this.winAdd(obj, values()[0]);
    if (obj.k === 'app' && name === 'draw') return this.appDraw();
    if (obj.k === 'sprite' && (name === 'draw' || name === 'alive')) return { k: 'slot', name: this.prog.sprites[obj.id]?.alive ?? 'alive', str: false };
    if (obj.k === 'hex' && name === 'neighbor') return neighbor(obj, numOf(values()[0] ?? { k: 'n', n: 0 }) ?? 0);
    if (obj.k === 'hex' && name === 'distance' && values()[0]?.k === 'hex') return { k: 'n', n: hexDistance(obj, values()[0] as Value & { k: 'hex' }) };
    if (obj.k === 'list' && name === 'hexes') return obj;
    this.fail(node, `${name} is not on these machines`);
    return { k: 'nil' };
  }

  private engineMethod(name: string, args: Value[], node: Ast): Value {
    if (name === 'sprite') return this.newSprite(args, node);
    if (name === 'motion') {
      const sprite = args[0];
      if (sprite?.k !== 'sprite') this.fail(node, 'motion needs a sprite');
      this.emit({ t: 'motion', id: sprite.id, dx: this.toExpr(args[1] ?? { k: 'n', n: 0 }), dy: this.toExpr(args[2] ?? { k: 'n', n: 0 }) });
      return { k: 'nil' };
    }
    if (name === 'update') {
      this.emit({ t: 'update' });
      return { k: 'nil' };
    }
    if (name === 'onCollision') {
      const fn = args[0];
      if (fn?.k !== 'fn') this.fail(node, 'onCollision needs a function');
      this.pushScope();
      const params = (fn.node.params as Array<{ name: string }>) ?? [];
      params.forEach((param, index) => {
        const sprite = this.prog.sprites[index];
        if (sprite) this.scope.set(param.name, { k: 'sprite', id: sprite.id });
      });
      const body = this.capture(() => this.block(fn.node.body as Ast[]));
      this.popScope();
      this.prog.hit.push(...body);
      return { k: 'nil' };
    }
    if (name === 'isKeyDown' || name === 'beep') {
      if (name === 'beep') {
        this.emit({
          t: 'tone',
          freq: this.toExpr(args[0] ?? { k: 'n', n: 440 }),
          ms: this.toExpr(args[1] ?? { k: 'n', n: 120 }),
          kind: 'tone',
        });
      }
      return { k: 'n', n: 0 };
    }
    if (name === 'draw' || name === 'stop' || name === 'start') return { k: 'nil' };
    this.fail(node, `Engine.${name} is not on these machines`);
    return { k: 'nil' };
  }

  private newSprite(args: Value[], node: Ast): Value {
    const picture = args[0];
    if (picture?.k !== 's') this.fail(node, 'a sprite needs an emoji string');
    const glyph = glyphFor(picture.s);
    const machine = MACHINE[this.target];
    const id = this.prog.sprites.length;
    const hardware = machine.hardwareSprites && id < machine.sprites;
    if (!hardware && this.target === 'c64') this.warn('The C64 has 8 hardware sprites. Extra emoji become software characters.');
    if (!hardware && this.target === 'ti99') this.warn('The TI-99/4A has 32 hardware sprites. Extra emoji become characters.');
    const base = this.nameHint || `s${id}`;
    const sprite = {
      id,
      emoji: picture.s,
      label: base,
      x: `${base}.x`,
      y: `${base}.y`,
      dx: `${base}.dx`,
      dy: `${base}.dy`,
      size: `${base}.size`,
      alive: `${base}.alive`,
      color: glyph.color,
      bits: glyph.bits,
      ascii: glyph.ascii,
      hardware,
    };
    const x = numOf(args[1] ?? { k: 'n', n: 0 }) ?? 0;
    const y = numOf(args[2] ?? { k: 'n', n: 0 }) ?? 0;
    const size = numOf(args[3] ?? { k: 'n', n: 16 }) ?? 16;
    this.emit({ t: 'let', name: sprite.x, str: false, expr: this.toExpr(args[1] ?? { k: 'n', n: x }) });
    this.emit({ t: 'let', name: sprite.y, str: false, expr: this.toExpr(args[2] ?? { k: 'n', n: y }) });
    this.emit({ t: 'let', name: sprite.dx, str: false, expr: { t: 'n', n: 0 } });
    this.emit({ t: 'let', name: sprite.dy, str: false, expr: { t: 'n', n: 0 } });
    this.emit({ t: 'let', name: sprite.size, str: false, expr: { t: 'n', n: size } });
    this.emit({ t: 'let', name: sprite.alive, str: false, expr: { t: 'n', n: 1 } });
    this.emit({ t: 'sprite', id });
    this.prog.sprites.push(sprite);
    const where = hardware
      ? this.target === 'c64'
        ? `VIC-II sprite ${id}`
        : `TMS9918 sprite ${id + 1}`
      : `lo-res software sprite ${id} (${glyph.ascii})`;
    this.note(`${picture.s} → ${where}`);
    return { k: 'sprite', id };
  }

  private terminalMethod(name: string, args: Value[], node: Ast): Value {
    if (name === 'write') {
      this.emit({ t: 'write', text: this.toExpr(args[0] ?? { k: 's', s: '' }) });
      return { k: 'nil' };
    }
    if (name === 'cls' || name === 'clear') {
      this.emit({ t: 'cls' });
      return { k: 'nil' };
    }
    if (name === 'locate' || name === 'put' || name === 'set') {
      this.emit({
        t: 'locate',
        col: this.toExpr(args[0] ?? { k: 'n', n: 0 }),
        row: this.toExpr(args[1] ?? { k: 'n', n: 0 }),
      });
      if (args[2]) this.emit({ t: 'write', text: this.toExpr(args[2]) });
      return { k: 'nil' };
    }
    this.fail(node, `Terminal.${name} is not on these machines`);
    return { k: 'nil' };
  }

  private scoreAdd(score: Value & { k: 'score' }, delta: Value): Value {
    const expr = this.toExpr(delta);
    this.emit({
      t: 'let',
      name: score.value,
      str: false,
      expr: { t: 'bin', op: '+', a: { t: 'v', name: score.value, str: false }, b: expr },
    });
    this.emit({
      t: 'if',
      cond: { t: 'bin', op: '>', a: { t: 'v', name: score.value, str: false }, b: { t: 'v', name: score.best, str: false } },
      yes: [{ t: 'let', name: score.best, str: false, expr: { t: 'v', name: score.value, str: false } }],
      no: [],
    });
    return { k: 'slot', name: score.value, str: false };
  }

  private stageGo(stage: Value & { k: 'stage' }, scene: Value | undefined, node: Ast): Value {
    if (scene?.k !== 'rec') this.fail(node, 'Stage.go needs a scene record');
    const enter = scene.fields.get('enter');
    const update = scene.fields.get('update');
    const draw = scene.fields.get('draw');
    stage.update = update?.k === 'fn' ? update.node : null;
    stage.draw = draw?.k === 'fn' ? draw.node : null;
    if (enter?.k === 'fn') this.emitCall(enter, []);
    return { k: 'nil' };
  }

  private stageUpdate(stage: Value & { k: 'stage' }, dt: Value | undefined): Value {
    if (stage.update) {
      const node = stage.update;
      const fn: Value = { k: 'fn', node, name: this.fnName(node) };
      this.emitCall(fn, dt ? [dt] : []);
    }
    return { k: 'nil' };
  }

  private loopRun(loop: Value & { k: 'loop' }, args: Value[]): Value {
    const count = numOf(args[0] ?? { k: 'n', n: 1 }) ?? 1;
    const ms = numOf(args[1] ?? { k: 'n', n: 16 }) ?? 16;
    const fn: Value = { k: 'fn', node: loop.fn, name: this.fnName(loop.fn) };
    const dt: Value = { k: 'n', n: ms / 1000 };
    const body = this.capture(() => this.emitCall(fn, [dt]));
    const slot = this.fresh('i');
    this.emit({ t: 'for', name: slot, from: { t: 'n', n: 1 }, to: { t: 'n', n: count }, step: { t: 'n', n: 1 }, body });
    return { k: 'nil' };
  }

  private fnName(node: Ast): string {
    if (node.name) return String(node.name);
    for (const [name, pending] of this.pending) if (pending === node) return name;
    const name = this.fresh('__fn');
    this.pending.set(name, node);
    return name;
  }

  private desktopAdd(value: Value | undefined): Value {
    if (value?.k === 'win') this.scope.set('__window', value);
    return { k: 'nil' };
  }

  private winAdd(win: Value & { k: 'win' }, value: Value | undefined): Value {
    if (value?.k === 'label') win.labels.push({ text: value.text, x: value.x, y: value.y });
    if (value?.k === 'win') this.scope.set('__window', value);
    return { k: 'nil' };
  }

  private appDraw(): Value {
    const seen = new Set<Value>();
    for (const value of this.scope.values()) {
      if (value.k !== 'win' || seen.has(value)) continue;
      seen.add(value);
      this.drawWindow(value);
    }
    return { k: 'nil' };
  }

  private drawWindow(win: Value & { k: 'win' }): void {
    const top = `+${win.title.slice(0, Math.max(0, win.w - 2)).padEnd(Math.max(0, win.w - 2), '-')}+`;
    this.emit({ t: 'locate', col: { t: 'n', n: win.x }, row: { t: 'n', n: win.y } });
    this.emit({ t: 'write', text: { t: 's', s: top } });
    for (const label of win.labels) {
      this.emit({ t: 'locate', col: { t: 'n', n: win.x + label.x }, row: { t: 'n', n: win.y + label.y } });
      this.emit({ t: 'write', text: { t: 's', s: label.text } });
    }
  }

  private emitCall(fn: Value & { k: 'fn' }, args: Value[]): void {
    const node = fn.node;
    const params = (node.params as Array<{ name: string }>) ?? [];
    const strs = args.map((arg) => this.isStr(arg));
    this.lowerFunction(fn.name, node, strs);
    const retStr = this.fns.find((item) => item.name === fn.name)?.ret?.str ?? false;
    const ret = params.length >= 0 ? { name: `${fn.name}.ret`, str: retStr } : null;
    this.emit({
      t: 'gosub',
      fn: fn.name,
      args: params.map((param, index) => ({
        name: `${fn.name}.${param.name}`,
        str: strs[index] ?? false,
        expr: this.toExpr(args[index] ?? { k: 'n', n: 0 }),
      })),
      ret,
    });
  }

  private callFn(fn: Value & { k: 'fn' }, args: Ast[], _node: Ast): Value {
    const values = args.map((arg) => this.value(arg));
    this.emitCall(fn, values);
    const retStr = this.fns.find((item) => item.name === fn.name)?.ret?.str ?? false;
    return { k: 'slot', name: `${fn.name}.ret`, str: retStr };
  }

  private lowerFunction(name: string, node: Ast, argStr: boolean[]): void {
    if (this.lowered.has(name)) return;
    this.lowered.add(name);
    const params = (node.params as Array<{ name: string }>) ?? [];
    const retStr = returnsString(node);
    const fn: RFn = {
      name,
      params: params.map((param, index) => ({ name: `${name}.${param.name}`, str: argStr[index] ?? false })),
      ret: { name: `${name}.ret`, str: retStr },
      body: [],
      line: node.line,
      column: node.column,
    };
    this.fns.push(fn);
    const savedPrefix = this.fnPrefix;
    const savedBlocks = this.blocks;
    this.fnPrefix = `${name}.`;
    this.blocks = [fn.body];
    this.pushScope();
    params.forEach((param, index) => {
      this.scope.set(param.name, { k: 'slot', name: `${name}.${param.name}`, str: argStr[index] ?? false });
    });
    this.block(node.body as Ast[]);
    this.popScope();
    this.blocks = savedBlocks;
    this.fnPrefix = savedPrefix;
  }

  private isStr(value: Value): boolean {
    if (value.k === 's') return true;
    if (value.k === 'slot') return value.str;
    if (value.k === 'expr') return value.str;
    return false;
  }

  private toExpr(value: Value): RExpr {
    switch (value.k) {
      case 'n':
        return { t: 'n', n: value.n };
      case 's':
        return { t: 's', s: value.s };
      case 'bool':
        return { t: 'n', n: value.v ? 1 : 0 };
      case 'nil':
        return { t: 'n', n: 0 };
      case 'slot':
        return { t: 'v', name: value.name, str: value.str };
      case 'expr':
        return value.expr;
      case 'hex':
        return { t: 's', s: `${value.q},${value.r}` };
      default:
        return { t: 'n', n: 0 };
    }
  }
}

function isConst(value: Value): boolean {
  return value.k === 'n' || value.k === 's' || value.k === 'bool' || value.k === 'nil';
}

function truth(value: Value): boolean {
  if (value.k === 'nil' || value.k === 'bool') return value.k === 'bool' ? value.v : false;
  if (value.k === 'n') return value.n !== 0;
  if (value.k === 's') return value.s !== '';
  return true;
}

function numOf(value: Value): number | null {
  if (value.k === 'n') return value.n;
  if (value.k === 'bool') return value.v ? 1 : 0;
  if (value.k === 'nil') return 0;
  return null;
}

function textOf(value: Value): string {
  if (value.k === 's') return value.s;
  if (value.k === 'n') return String(value.n);
  if (value.k === 'bool') return value.v ? 'true' : 'false';
  if (value.k === 'nil') return '';
  if (value.k === 'hex') return `${value.q},${value.r}`;
  return '';
}

function typeName(value: Value): string {
  switch (value.k) {
    case 'n':
      return 'number';
    case 's':
      return 'string';
    case 'bool':
      return 'bool';
    case 'nil':
      return 'nil';
    case 'list':
      return 'list';
    case 'fn':
      return 'fn';
    default:
      return value.k;
  }
}

function foldNum(op: string, a: number, b: number): number | boolean | null {
  switch (op) {
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
    case '==':
    case '=':
      return a === b;
    case '!=':
    case '<>':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    default:
      return null;
  }
}

function returnsString(node: Ast): boolean {
  const stack = [...((node.body as Ast[]) ?? [])];
  while (stack.length) {
    const stmt = stack.pop();
    if (!stmt) continue;
    if (stmt.kind === 'return' && stmt.value && (stmt.value as Ast).kind === 'string') return true;
    if (stmt.kind === 'return' && stmt.value && (stmt.value as Ast).kind === 'binary' && (stmt.value as Ast).op === '&') return true;
    if (stmt.kind === 'if') {
      for (const arm of (stmt.arms as Ast[]) ?? []) stack.push(...((arm.body as Ast[]) ?? []));
      stack.push(...((stmt.elseBody as Ast[]) ?? []));
    }
  }
  return false;
}

function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  const as = -a.q - a.r;
  const bs = -b.q - b.r;
  return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(as - bs));
}

function neighbor(cell: { q: number; r: number }, dir: number): Value {
  const index = ((Math.trunc(dir) % 6) + 6) % 6;
  return { k: 'hex', q: cell.q + (DIR_Q[index] ?? 0), r: cell.r + (DIR_R[index] ?? 0) };
}

function ring(center: { q: number; r: number }, radius: number): Value[] {
  const steps = Math.trunc(radius);
  if (steps <= 0) return [{ k: 'hex', q: center.q, r: center.r }];
  const out: Value[] = [];
  let cursor = { q: center.q + (DIR_Q[4] ?? 0) * steps, r: center.r + (DIR_R[4] ?? 0) * steps };
  for (let side = 0; side < 6; side += 1) {
    for (let step = 0; step < steps; step += 1) {
      out.push({ k: 'hex', q: cursor.q, r: cursor.r });
      const next = neighbor(cursor, side);
      if (next.k === 'hex') cursor = next;
    }
  }
  return out;
}

function spiral(center: { q: number; r: number }, radius: number): Value[] {
  const out = ring(center, 0);
  for (let n = 1; n <= radius; n += 1) out.push(...ring(center, n));
  return out;
}

function toPixel(q: number, r: number, size: number): { x: number; y: number } {
  return {
    x: size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    y: size * (3 / 2) * r,
  };
}

function roundHex(q: number, r: number): Value {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { k: 'hex', q: rq, r: rr };
}

function approach(current: number, target: number, step: number): number {
  const delta = target - current;
  const pace = Math.abs(step);
  if (Math.abs(delta) <= pace) return target;
  return current + Math.sign(delta) * pace;
}

function wrap(n: number, length: number): number {
  if (!length) return 0;
  return ((n % length) + length) % length;
}

function freqOf(name: string, node: Ast, fail: (where: Ast, message: string) => never): number {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!match) fail(node, `note needs a name like C4 or A#3, not ${name}`);
  const letter = (match[1] ?? 'a').toLowerCase();
  const accidental = match[2] ?? '';
  const octave = Number(match[3]);
  const semi = (SEMI[letter] ?? 0) + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
  const midi = (octave + 1) * 12 + semi;
  return 440 * 2 ** ((midi - 69) / 12);
}
