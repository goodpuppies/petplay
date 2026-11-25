import { assertEquals } from "@std/assert";
import {
  isNewerRelease,
  parseSha256Sums,
  parseVersionTag,
  releaseAssetName,
} from "./updater.ts";

Deno.test("parseVersionTag handles release tags and git describe versions", () => {
  assertEquals(parseVersionTag("v0.0.17"), { major: 0, minor: 0, patch: 17, commitsAhead: 0 });
  assertEquals(parseVersionTag("0.1.2-9-g777e0e3"), {
    major: 0,
    minor: 1,
    patch: 2,
    commitsAhead: 9,
  });
  assertEquals(parseVersionTag("v0.0.17-3-gabcdef1-dirty"), {
    major: 0,
    minor: 0,
    patch: 17,
    commitsAhead: 3,
  });
  assertEquals(parseVersionTag("dev"), null);
});

Deno.test("isNewerRelease compares semver and commitsAhead accurately", () => {
  assertEquals(isNewerRelease("v0.0.17", "v0.0.18"), true);
  assertEquals(isNewerRelease("v0.0.17", "v0.0.17"), false);
  assertEquals(isNewerRelease("v0.0.18", "v0.0.17"), false);
  assertEquals(isNewerRelease("v0.0.17-5-gabc1234", "v0.0.17"), false);
  assertEquals(isNewerRelease("v0.0.17-5-gabc1234", "v0.0.18"), true);
  assertEquals(isNewerRelease("v0.9.9", "v1.0.0"), true);
});

Deno.test("parseSha256Sums extracts matching hash for platform asset", () => {
  const sums = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  petplay",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  petplay.exe",
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc *dist/petplay-aarch64",
  ].join("\n");
  assertEquals(
    parseSha256Sums(sums, "petplay"),
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assertEquals(
    parseSha256Sums(sums, "petplay.exe"),
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assertEquals(
    parseSha256Sums(sums, "petplay-aarch64"),
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  );
  assertEquals(parseSha256Sums(sums, "missing"), null);
});

Deno.test("releaseAssetName maps supported OS/arch targets", () => {
  assertEquals(releaseAssetName("linux", "x86_64"), "petplay");
  assertEquals(releaseAssetName("linux", "aarch64"), "petplay-aarch64");
  assertEquals(releaseAssetName("windows", "x86_64"), "petplay.exe");
  assertEquals(releaseAssetName("darwin", "aarch64"), null);
});
