# RETRO-MAGIC

Alpha. This is early work, and it can still change. Mira, [The White Witch™](https://thewhitewitchtm.github.io/whitewitch/). [X](https://x.com/TheWhiteWitchTM) · [thewhitewitchtm@google.com](mailto:thewhitewitchtm@google.com) · [GitHub](https://github.com/TheWhiteWitchTM) · [YouTube](https://youtube.com/@TheWhiteWitchTM) · [Bluesky](https://bsky.app/profile/thewhitewitchtm.sociallydead.me) · [MIT License](LICENSE)

RETRO-MAGIC is [MAGIC](https://github.com/TheWhiteWitchTM/MAGIC) for three 8-bit machines: the Commodore 64, the Apple II, and the TI-99/4A. A script still looks like MAGIC. The compiler writes a BASIC listing and an assembly listing, and it can run both. The C64 and the Apple II share the 6502. The TI-99/4A uses the TMS9900.

`@3d` does not fit these machines. The compiler stops and tells you to drop it. `@canvas`, `@terminal`, `@sound`, `@hex`, `@games`, and a small text `@ui` stay.

An emoji in a sprite becomes an 8×8 picture. On the C64 that picture is a VIC-II sprite. On the TI-99/4A it is a TMS9918 sprite for Extended BASIC. The Apple II has no sprite chip, so the same picture is plotted in lo-res.

`@c64`, `@apple2`, and `@ti99` keep a statement on that machine. `@target("c64")` picks the machine when the command line does not.

## Install and run the demo

```bash
npm install
npm test
```

`npm test` compiles `src/` and runs `examples/demo.js`. The demo runs MAGIC, the BASIC listing, and the assembly listing for hello, a sum, a sprite scene, and the modules. It also checks cross-target annotations, emoji sprites, a hand-written BASIC line, and the two CPUs.

## Commands

```bash
npx retro run examples/hello.magic --target c64
npx retro compile examples/scene.magic --target all --as basic
npx retro compile examples/scene.magic --target ti99 --as asm
npx retro basic run examples/add.bas --target apple2
npx retro asm run examples/add.asm --cpu 6502 --target c64
npx retro asm run examples/add.a99 --cpu 9900
npx retro targets
```

`node dist/cli.js` is the same program.

`retro run` is the host screen. It prints what the program prints. `retro compile` writes the BASIC listing, the assembly listing, or both. `retro basic` runs, checks, or tokenizes a listing. Tokenize writes a C64 or Applesoft program image. `retro asm` assembles and runs 6502 or TMS9900 source. The C64 image is a PRG with a SYS stub. The Apple II image has a 4-byte start-and-length header. The TI-99/4A image is a raw binary from `>A000`.

## Targets

| Name | Machine | CPU | Text | Sprites |
| --- | --- | --- | --- | --- |
| `c64` | Commodore 64 | 6502 | 40×25 | 8 VIC-II sprites, 24×21 |
| `apple2` | Apple II | 6502 | 40×24 | none; emoji are lo-res plots |
| `ti99` | TI-99/4A | TMS9900 | 32×24 | 32 TMS9918 sprites |

C64 BASIC is V2, so the listing avoids `ELSE`. Apple BASIC is Applesoft. TI sprite programs are Extended BASIC. Names in the C64 and Apple listings are two characters, and a `REM` line maps them back.

## A sprite

```
@canvas

let engine = new Engine({ width: 320, height: 200 })
let spark = engine.sprite("✦", 40, 90, 28)
engine.motion(spark, 8, 0)
```

`✦` compiles to the same 8×8 bits on every machine. The note in the listing says where it landed: `VIC-II`, `TMS9918`, or lo-res.

## One file, three machines

```
@target("c64")

@c64
print "on c64"

@apple2
print "on apple"

@ti99
print "on ti"

print "all"
```

`retro compile examples/cross.magic --target apple2` keeps the Apple line and the shared line.
