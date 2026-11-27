/**
 * The executable this PetPlay was started from, read when the process starts. Once an update has
 * replaced that file (classes/installer.ts), Linux reports the running executable as
 * `<path> (deleted)`; the path itself then holds the new build, which is what a restart or an
 * installer process should run.
 */
export const launchedFrom = Deno.execPath().replace(/ \(deleted\)$/, "");
