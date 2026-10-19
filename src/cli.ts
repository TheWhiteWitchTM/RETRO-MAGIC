#!/usr/bin/env node
/**
 * `retro` compiles and runs MAGIC, BASIC, and assembly
 * for the C64, the Apple II, and the TI-99/4A.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assembleSource, checkSource, compileMagic, resolveTarget, runAsm, runBasicSource, runMagic } from './compile.js';
import { checkBasic, tokenizeBasic } from './basic-run.js';
import { MACHINE, TARGETS, type TargetName } from './glyph.js';

interface Flags {
  target: string;
  as: string;
  cpu: string;
  out: string;
}

const HELP = `retro — MAGIC, BASIC, and assembly for the C64, Apple II, and TI-99/4A

  retro run <file> [--target c64|apple2|ti99]
  retro compile <file> [--target c64|apple2|ti99|all] [--as basic|asm|both] [-o file]
  retro check <file> [--target c64|apple2|ti99]
  retro basic run <file> [--target c64|apple2|ti99]
  retro basic check <file>
  retro basic tokenize <file> --target c64|apple2 [-o file]
  retro asm assemble <file> [--cpu 6502|9900] [--target c64|apple2|ti99] [-o file]
  retro asm run <file> [--cpu 6502|9900] [--target c64|apple2|ti99]
  retro targets
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): { position: string[]; flags: Flags } {
  const position: string[] = [];
  const flags: Flags = { target: '', as: 'both', cpu: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--target') flags.target = argv[++i] ?? '';
    else if (arg === '--as') flags.as = argv[++i] ?? 'both';
    else if (arg === '--cpu') flags.cpu = argv[++i] ?? '';
    else if (arg === '-o' || arg === '--out') flags.out = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') position.push('--help');
    else position.push(arg);
  }
  return { position, flags };
}

function readSource(file: string): string {
  if (!file) fail('name a source file');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) fail(`no such file ${file}`);
  return fs.readFileSync(abs, 'utf8');
}

function targetOf(flag: string, source: string, filename: string): TargetName {
  if (!flag) return resolveTarget(source, { filename });
  if (flag === 'c64' || flag === 'apple2' || flag === 'ti99') return flag;
  fail(`unknown target ${flag}`);
}

function targetsOf(flag: string, source: string, filename: string): TargetName[] {
  if (flag === 'all') return [...TARGETS];
  return [targetOf(flag, source, filename)];
}

function cpuOf(flag: string, target: TargetName): '6502' | '9900' {
  if (flag === '6502' || flag === '9900') return flag;
  if (flag) fail(`unknown cpu ${flag}`);
  return target === 'ti99' ? '9900' : '6502';
}

function writeOut(file: string, data: string | Uint8Array): void {
  if (!file) {
    if (typeof data === 'string') process.stdout.write(data.endsWith('\n') ? data : `${data}\n`);
    else process.stdout.write(Buffer.from(data));
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (typeof data === 'string') fs.writeFileSync(file, data);
  else fs.writeFileSync(file, data);
}

function printProblems(problems: Array<{ filename?: string; line: number; column: number; message: string }>, filename: string): void {
  for (const problem of problems) {
    const where = problem.filename || filename;
    console.error(`${where}:${problem.line}:${problem.column} ${problem.message}`);
  }
}

function main(): void {
  const { position, flags } = parseArgs(process.argv.slice(2));
  const [command, second, third] = position;
  if (!command || command === '--help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'targets') {
    for (const name of TARGETS) {
      const machine = MACHINE[name];
      console.log(`${name}\t${machine.name}\t${machine.cpu}\t${machine.cols}x${machine.rows}\tsprites ${machine.sprites}`);
    }
    return;
  }

  if (command === 'run') {
    const file = second ?? '';
    const source = readSource(file);
    const target = targetOf(flags.target, source, file);
    const screen = runMagic(source, { filename: file, target });
    process.stdout.write(screen.output);
    if (screen.caption) console.error(screen.caption);
    return;
  }

  if (command === 'check') {
    const file = second ?? '';
    const source = readSource(file);
    const target = targetOf(flags.target, source, file);
    const result = checkSource(source, { filename: file, target });
    if (!result.ok) {
      printProblems(result.problems, file);
      process.exit(1);
    }
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    console.log('ok');
    return;
  }

  if (command === 'compile') {
    const file = second ?? '';
    const source = readSource(file);
    const targets = targetsOf(flags.target, source, file);
    const chunks: string[] = [];
    for (const target of targets) {
      const compiled = compileMagic(source, { filename: file, target });
      for (const warning of compiled.warnings) console.error(`warning: ${warning}`);
      if (compiled.asmError) console.error(`assembly: ${compiled.asmError}`);
      const basic = `; ---- ${target} BASIC ----\n${compiled.basic}\n`;
      const asm = `; ---- ${target} assembly ----\n${compiled.asm}\n`;
      if (flags.as === 'basic') chunks.push(compiled.basic.endsWith('\n') ? compiled.basic : `${compiled.basic}\n`);
      else if (flags.as === 'asm') chunks.push(compiled.asm.endsWith('\n') ? compiled.asm : `${compiled.asm}\n`);
      else chunks.push(`${basic}\n${asm}`);
    }
    writeOut(flags.out, chunks.join('\n'));
    return;
  }

  if (command === 'basic') {
    const action = second;
    const file = third ?? '';
    const source = readSource(file);
    if (action === 'check') {
      const result = checkBasic(source, file);
      if (!result.ok) {
        printProblems(result.problems, file);
        process.exit(1);
      }
      console.log('ok');
      return;
    }
    if (action === 'tokenize') {
      const target = flags.target === 'apple2' ? 'apple2' : 'c64';
      if (flags.target && flags.target !== 'c64' && flags.target !== 'apple2') fail('tokenize writes C64 or Applesoft');
      const bytes = tokenizeBasic(source, target);
      writeOut(flags.out, bytes);
      return;
    }
    if (action === 'run') {
      const target = flags.target === 'apple2' || flags.target === 'ti99' || flags.target === 'c64' ? flags.target : 'c64';
      const result = runBasicSource(source, { target, filename: file });
      process.stdout.write(result.output);
      return;
    }
    fail('retro basic run|check|tokenize <file>');
  }

  if (command === 'asm') {
    const action = second;
    const file = third ?? '';
    const source = readSource(file);
    const target = flags.target === 'apple2' || flags.target === 'ti99' || flags.target === 'c64' ? flags.target : 'c64';
    const cpu = cpuOf(flags.cpu, target);
    if (action === 'assemble') {
      const image = assembleSource(source, { cpu, target });
      writeOut(flags.out, image.image);
      if (!flags.out) console.error(`${image.format} ${image.image.length} bytes at $${image.org.toString(16)}`);
      return;
    }
    if (action === 'run') {
      const result = runAsm(source, { cpu, target });
      process.stdout.write(result.output);
      console.error(result.halted);
      return;
    }
    fail('retro asm assemble|run <file>');
  }

  fail(`unknown command ${command}\n${HELP}`);
}

main();
