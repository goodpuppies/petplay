import { assertEquals } from "@std/assert";
import { quoteWindowsArg } from "./windowsOwnConsole.ts";

Deno.test("quoteWindowsArg leaves plain arguments alone", () => {
  assertEquals(quoteWindowsArg("dev"), "dev");
  assertEquals(quoteWindowsArg("--text-renderer=pathfinder"), "--text-renderer=pathfinder");
  assertEquals(quoteWindowsArg("C:\\PetPlay\\petplay.exe"), "C:\\PetPlay\\petplay.exe");
});

Deno.test("quoteWindowsArg quotes what CommandLineToArgvW would split or unquote", () => {
  assertEquals(quoteWindowsArg(""), '""');
  assertEquals(quoteWindowsArg("C:\\Program Files\\petplay.exe"), '"C:\\Program Files\\petplay.exe"');
  assertEquals(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  // Backslashes double only before a quote, the closing one included.
  assertEquals(quoteWindowsArg("C:\\My Dir\\"), '"C:\\My Dir\\\\"');
  assertEquals(quoteWindowsArg('a\\"b c'), '"a\\\\\\"b c"');
});
