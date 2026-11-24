import { assertEquals } from "@std/assert";
import { stub } from "@std/testing/mock";
import raylib from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import { RaylibAudioBackend, RaylibAudioContext } from "./raylibAudioContext.ts";

function fakeAudio(options: { device?: boolean; sound?: boolean; initError?: boolean } = {}) {
  const calls: string[] = [];
  const mocks: { restore(): void }[] = [
    stub(raylib, "isRaylibLoaded", () => true),
    stub(raylib, "IsAudioDeviceReady", () => options.device ?? true),
    stub(raylib, "InitAudioDevice", () => {
      if (options.initError) throw new Error("device init failed");
    }),
    stub(raylib.H, "LoadWaveFromMemory", () => ({} as raylib.Wave)),
    stub(raylib.H, "IsWaveValid", () => true),
    stub(raylib.H, "LoadSoundFromWave", () => ({} as raylib.Sound)),
    stub(raylib.H, "UnloadWave", () => {
      calls.push("unload-wave");
    }),
    stub(raylib.H, "IsSoundValid", () => options.sound ?? true),
    stub(raylib.H, "LoadSoundAlias", () => {
      calls.push("alias");
      return ({} as raylib.Sound);
    }),
    stub(raylib.H, "SetSoundPan", () => {}),
    stub(raylib.H, "SetSoundVolume", () => {}),
    stub(raylib.H, "SetSoundPitch", () => {}),
    stub(raylib.H, "PlaySound", () => {
      calls.push("play");
    }),
    stub(raylib.H, "StopSound", () => {
      calls.push("stop");
    }),
    stub(raylib.H, "UnloadSoundAlias", () => {}),
    stub(raylib.H, "UnloadSound", () => {
      calls.push("unload-sound");
    }),
  ];
  const context = new RaylibAudioContext();
  const backend = new RaylibAudioBackend();
  backend.initialize(context);
  return {
    calls,
    backend,
    context,
    play: () =>
      context.onPlayback?.({ cue: "key", gain: 1, pan: 0.5, distance: 1, playbackRate: 1 }),
    cleanup: () => {
      try {
        backend.dispose();
      } finally {
        for (const mock of mocks.reverse()) mock.restore();
      }
    },
  };
}

for (const initError of [false, true]) {
  Deno.test(`unavailable audio stays silent (init throws: ${initError})`, () => {
    const audio = fakeAudio({ device: false, initError });
    try {
      audio.play();
      audio.play();
      assertEquals(audio.calls, []);
    } finally {
      audio.cleanup();
    }
  });
}

Deno.test("failed sound creation never reaches native alias creation or playback", () => {
  const audio = fakeAudio({ sound: false });
  try {
    audio.play();
    audio.play();
    assertEquals(audio.calls, ["unload-wave"]);
  } finally {
    audio.cleanup();
  }
});

Deno.test("a stop callback retained past disposal never touches released sound buffers", () => {
  const audio = fakeAudio();
  try {
    const stop = audio.play();
    assertEquals(audio.calls.filter((call) => call === "play").length, 1);
    audio.backend.dispose();
    if (stop) stop();
    assertEquals(audio.calls.filter((call) => call === "stop").length, 0);
    assertEquals(audio.context.onPlayback, null);
  } finally {
    audio.cleanup();
  }
});
