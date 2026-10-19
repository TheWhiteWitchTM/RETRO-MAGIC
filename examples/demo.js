import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleSource,
  c64Sprite,
  checkSource,
  compileMagic,
  glyphFor,
  runAsm,
  runBasic,
  runMagic,
  TARGETS,
  tokenizeBasic,
} from '../dist/index.js';

const root = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;

function flat(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `\n${detail}` : ''}`);
}

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function word(bytes, index) {
  return ((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0);
}

const MODULES = '2 6 7 1 17 7 6 4 5 4 3 3 3 4 4 2 440 30 4 modules ok';
const hello = read('hello.magic');
const sum = read('sum.magic');
const scene = read('scene.magic');
const modules = read('modules.magic');
const cross = read('cross.magic');
const emoji = read('emoji.magic');
const basic = read('add.bas');

for (const target of TARGETS) {
  const hostHello = runMagic(hello, { filename: 'hello.magic', target });
  check(`magic hello ${target}`, flat(hostHello.output) === 'Hello, MAGIC', flat(hostHello.output));
  const hostSum = runMagic(sum, { filename: 'sum.magic', target });
  check(`magic sum ${target}`, flat(hostSum.output) === '10', flat(hostSum.output));
  const hostScene = runMagic(scene, { filename: 'scene.magic', target });
  check(`magic scene ${target}`, flat(hostScene.output) === 'scene ok', flat(hostScene.output));
  const hostModules = runMagic(modules, { filename: 'modules.magic', target });
  check(`magic modules ${target}`, flat(hostModules.output) === MODULES, flat(hostModules.output));

  const compiledHello = compileMagic(hello, { filename: 'hello.magic', target });
  let basicHello = '';
  try {
    basicHello = runBasic(compiledHello.basic, { target, filename: 'hello.magic' }).output;
  } catch (error) {
    basicHello = error instanceof Error ? error.message : String(error);
  }
  check(`basic hello ${target}`, flat(basicHello) === 'Hello, MAGIC', flat(basicHello));

  const compiledSum = compileMagic(sum, { filename: 'sum.magic', target });
  let basicSum = '';
  try {
    basicSum = runBasic(compiledSum.basic, { target }).output;
  } catch (error) {
    basicSum = error instanceof Error ? error.message : String(error);
  }
  check(`basic sum ${target}`, flat(basicSum) === '10', flat(basicSum));

  const compiledScene = compileMagic(scene, { filename: 'scene.magic', target });
  let basicScene = '';
  try {
    basicScene = runBasic(compiledScene.basic, { target }).output;
  } catch (error) {
    basicScene = error instanceof Error ? error.message : String(error);
  }
  check(`basic scene ${target}`, flat(basicScene) === 'scene ok', flat(basicScene));

  const compiledModules = compileMagic(modules, { filename: 'modules.magic', target });
  let basicModules = '';
  try {
    basicModules = runBasic(compiledModules.basic, { target }).output;
  } catch (error) {
    basicModules = error instanceof Error ? error.message : String(error);
  }
  check(`basic modules ${target}`, flat(basicModules) === MODULES, flat(basicModules));

  const cpu = target === 'ti99' ? '9900' : '6502';
  for (const [label, compiled, expect] of [
    ['hello', compiledHello, 'Hello, MAGIC'],
    ['sum', compiledSum, '10'],
    ['scene', compiledScene, 'scene ok'],
    ['modules', compiledModules, MODULES],
  ]) {
    if (compiled.asmError) {
      check(`asm ${label} ${target}`, false, compiled.asmError);
      continue;
    }
    try {
      const ran = runAsm(compiled.asm, { cpu, target });
      check(`asm ${label} ${target}`, flat(ran.output) === expect, `${ran.halted} ${flat(ran.output)}`);
    } catch (error) {
      check(`asm ${label} ${target}`, false, error instanceof Error ? error.message : String(error));
    }
  }

  const hostCross = runMagic(cross, { filename: 'cross.magic', target });
  const crossText = flat(hostCross.output);
  const own = target === 'c64' ? 'on c64' : target === 'apple2' ? 'on apple' : 'on ti';
  const other = TARGETS.filter((name) => name !== target).map((name) => (name === 'c64' ? 'on c64' : name === 'apple2' ? 'on apple' : 'on ti'));
  check(`cross ${target}`, crossText === `${own} all` && other.every((line) => !crossText.includes(line)), crossText);

  const picture = compileMagic(emoji, { filename: 'emoji.magic', target });
  const note = picture.notes.join(' ');
  const want = target === 'c64' ? 'VIC-II' : target === 'ti99' ? 'TMS9918' : 'lo-res';
  check(`emoji note ${target}`, picture.notes.length >= 2 && note.includes(want) && flat(picture.output) === '8 40', `${note} / ${flat(picture.output)}`);
  if (target === 'apple2') check('apple caption', picture.screen.caption.includes('no sprite chip'));
}

const spark = glyphFor('✦');
check('glyph rows', spark.bits.length === 8 && spark.bits.every((row) => row >= 0 && row <= 255));
check('c64 sprite bytes', c64Sprite(spark.bits).length === 64);

const dropped = checkSource(read('drop3d.magic'), { filename: 'drop3d.magic' });
check('drops 3d', !dropped.ok && dropped.problems.some((problem) => problem.message.includes('Drop @3d')));

for (const target of TARGETS) {
  const ran = runBasic(basic, { target, filename: 'add.bas' });
  check(`hand basic ${target}`, flat(ran.output) === '42', flat(ran.output));
}

const c64Tokens = tokenizeBasic('10 PRINT "HI"\n', 'c64');
const appleTokens = tokenizeBasic('10 PRINT "HI"\n', 'apple2');
check('c64 PRINT token', c64Tokens.includes(0x99));
check('applesoft PRINT token', appleTokens.includes(0xba));

const cpu6502 = runAsm(read('add.asm'), { cpu: '6502', target: 'c64' });
check('6502 20+22', cpu6502.memory[0x400] === 42 && cpu6502.halted === 'brk', `mem ${cpu6502.memory[0x400]} ${cpu6502.halted}`);

const cpu9900 = runAsm(read('add.a99'), { cpu: '9900', target: 'ti99' });
check('9900 20+22', (cpu9900.registers?.[1] ?? 0) === 42 && cpu9900.halted === 'jmp', `r1 ${cpu9900.registers?.[1]} ${cpu9900.halted}`);

const mov = assembleSource('AORG >A000\nMOV R1,R2\n', { cpu: '9900' });
check('MOV R1,R2', word(mov.bytes, 0) === 0xc081, word(mov.bytes, 0).toString(16));

const movAt = assembleSource('AORG >A000\nMOV R1,@LABEL\nJMP $\nLABEL:\nDATA 0\n', { cpu: '9900' });
check('MOV R1,@LABEL', word(movAt.bytes, 0) === 0xc801 && word(movAt.bytes, 2) === (movAt.symbols.LABEL ?? -1), `${word(movAt.bytes, 0).toString(16)} ${word(movAt.bytes, 2).toString(16)} ${movAt.symbols.LABEL?.toString(16)}`);

const li = assembleSource('AORG >A000\nLI R1,7\n', { cpu: '9900' });
check('LI R1,7', word(li.bytes, 0) === 0x0201 && word(li.bytes, 2) === 7, word(li.bytes, 0).toString(16));

const clr = assembleSource('AORG >A000\nCLR R2\n', { cpu: '9900' });
check('CLR R2', word(clr.bytes, 0) === 0x04c2, word(clr.bytes, 0).toString(16));

const jne = assembleSource('AORG >A000\nJNE NEXT\nJMP $\nNEXT:\nJMP $\n', { cpu: '9900' });
check('JNE', word(jne.bytes, 0) === 0x1601, word(jne.bytes, 0).toString(16));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('demo ok');
