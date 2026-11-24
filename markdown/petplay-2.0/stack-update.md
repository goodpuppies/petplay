# Track 7: Stack update

Bring the rendering and interaction stack up to current versions before optimizing the CPU path
([track 3](./stability-performance.md)). Profiling and tuning against old internals is wasted
work once they change.

## Today (2026-10-11)

| Package | Pinned | Current upstream |
|---|---|---|
| `@react-three/fiber` | `10.0.0-alpha.2` (`classes/r3fWebgpuCompat.ts`) | `10.0.0-alpha.5`; canaries daily (`10.0.0-canary.*`); stable is 9.8.1 |
| `three` | jsdelivr commit `30e9dd1b` (`deno.json`), lock has 0.184.0 | 0.186.1 |
| `@pmndrs/xr` / `handle` / `pointer-events` | fork `mommysgoodpuppy/xr`, 2026-09-20 (has our one-hand-scaling HandleStore work) | upstream pmndrs/xr |
| `@pmndrs/uikit` | upstream, 2026-05-06 | upstream main |
| IWER | fork `mommysgoodpuppy/immersive-web-emulation-runtime` 2.2.0, 2026-05-11 | upstream |
| `react` | 19.2.5 | — |

All of these come in through the `submodules/threewebxrwebgpudeno` workspace member.

## Plan

1. r3f → newest v10 prerelease (alpha.5 or a pinned canary). Re-check the compat shim
   (`r3fWebgpuCompat.ts`: legacy `useFrame` with `XRFrame`, `state.clock`), which tracks the v10
   scheduler API.
2. three → 0.186.x. Re-verify raythree extraction (`submodules/raythree`), since it reads three
   internals, and the TSL materials.
3. Rebase the xr fork on upstream. Upstream the HandleStore changes if pmndrs will take them,
   so the fork gets smaller.
4. uikit and IWER → latest. Rebase the IWER fork's "extra mods".
5. After each step, run the playtest smoke + an `overlay:perf` capture and compare to the
   pre-update baseline, so a regression has one clear cause.

## Progress

- 2026-10-11: steps 1–2 done. r3f is on `10.0.0-alpha.5`, three on `0.186.1`, `@types/three`
  on 0.186. `three` now maps to `npm:three@0.186.1/*` instead of a jsdelivr URL. Before this,
  two three copies were loaded: r3f's npm peer (it created the `Scene`) and the jsdelivr build
  (everything else). Now there's one. A root `overrides` entry pins every npm consumer to the
  same version, and meshline is mapped to its ESM build so it stops `require`-ing the CJS three.
  `deno task check` went from 16 to 11 errors in our code (752 → 151 filtered). `overlay:perf`
  r3f avg went from about 0.48 to 0.55 ms per frame (likely the v10 scheduler; look at it in
  the perf pass).
  Server RSS went from about 344 to 313 MB.

- 2026-11-24: three → 0.187.0 (`@types/three` 0.187.0). No new type errors (only the vendored
  ones, unchanged), 460/462 tests (the two failures predate it), raythree extraction tests pass.
  Deps now live in `package.json`; the browser bundles pin `npm:three@0.187.0`.
  uikit v1.0.78 was tried and backed out: upstream split `panel-material.ts`,
  `instanced-panel*.ts` and `interaction-panel-mesh.ts` into `panel/material/*`,
  `panel/instance/*` and `panel/interaction/*`, which `local-uikit` (our WebGPU/raylib layer,
  about 200 lines of changes on the old panel files) imports directly; property values can now
  be numeric strings; and it needs `zod` and generated `src/flex/schema.ts` (run
  `scripts/flex-generate-setter.ts`; `setup-submodules.ts` does). Porting `local-uikit` onto the
  new modules is its own task, verified in VR.
- 2026-11-24: xr fork rebased on upstream main and reduced to upstream-PR-shaped commits (webgpu
  session feature, controller key fix, hinge axis fix, HandleStore extensibility, r3f v10 frame
  priorities, hit-test speed-up). PetPlay's grab behaviour moved to
  `classes/environment/petplayHandleStore.tsx`.
- 2026-11-24: r3f → 10.0.0-alpha.6. Its scheduler is now `@pmndrs/scheduler` 0.3.0, which shares
  one frame state among jobs, so `r3fWebgpuCompat.ts` no longer patches `tickRoot` (the old patch
  read a removed internal and stopped every frame job, uikit layout included). `state.gl` is
  deprecated in favour of `state.renderer` and is typed by a registered renderer:
  `types/r3f-webgpu-renderer.d.ts` registers `webgpu` (its version pin moves with the others).
  460/462 tests, same two pre-existing failures.

## Done when

Everything is on current versions, the forks are rebased with their diff documented, and the
perf baseline is no worse than before the update.
