/**
 * PetPlay's own console window on Windows, so the taskbar shows PetPlay: its icon and its name.
 *
 * The release is a console program. Double-clicked on Windows 11, its new console is handed to the
 * default terminal (Windows Terminal), and the taskbar button is the terminal's, with the
 * terminal's icon. A classic console window (conhost) is a taskbar button of its own, so a PetPlay
 * that was handed to a terminal reopens itself in one, names it and gives it PetPlay's icon, and
 * the terminal tab closes.
 *
 * Started from a terminal the user already has open, PetPlay stays in it: that console is shared
 * with the shell. A launcher that started PetPlay without a console window keeps it that way.
 */
const kernel32Symbols = {
  GetConsoleProcessList: { parameters: ["buffer", "u32"], result: "u32" },
  GetConsoleWindow: { parameters: [], result: "pointer" },
  SetConsoleTitleW: { parameters: ["buffer"], result: "i32" },
} as const;
const user32Symbols = {
  GetClassNameW: { parameters: ["pointer", "buffer", "i32"], result: "i32" },
  PostMessageW: { parameters: ["pointer", "u32", "usize", "pointer"], result: "i32" },
} as const;
const shell32Symbols = {
  ShellExecuteW: {
    parameters: ["pointer", "pointer", "buffer", "buffer", "pointer", "i32"],
    result: "pointer",
  },
  ExtractIconExW: { parameters: ["buffer", "i32", "buffer", "buffer", "u32"], result: "u32" },
} as const;
const SW_SHOWNORMAL = 1;
const WM_SETICON = 0x0080;
const ICON_SMALL = 0n;
const ICON_BIG = 1n;

/** The class of a console window that conhost draws itself: a taskbar button of its own. */
const CONSOLE_WINDOW_CLASS = "ConsoleWindowClass";
/** The class of the windowless stand-in a console has while a terminal shows it. */
const PSEUDO_CONSOLE_WINDOW_CLASS = "PseudoConsoleWindow";

/** Set on the reopened PetPlay, so it never reopens itself again. */
const REOPENED_ENV = "PETPLAY_OWN_CONSOLE";
const TITLE = "PetPlay";

function wide(text: string): Uint16Array<ArrayBuffer> {
  const chars = new Uint16Array(text.length + 1);
  for (let i = 0; i < text.length; i++) chars[i] = text.charCodeAt(i);
  return chars;
}

/** Quotes one argument for a Windows command line (the rules `CommandLineToArgvW` reads). */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? backslashes * 2 + 1 : backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

function windowClass(
  user32: Deno.DynamicLibrary<typeof user32Symbols>,
  window: Deno.PointerObject,
): string {
  const name = new Uint16Array(64);
  const length = user32.symbols.GetClassNameW(window, name, name.length);
  return String.fromCharCode(...name.subarray(0, Math.max(0, length)));
}

/**
 * Gives a console window PetPlay's icon from its own executable. A conhost started directly, as
 * the reopened PetPlay's is, shows the generic console icon rather than its program's.
 */
function setWindowIcon(
  user32: Deno.DynamicLibrary<typeof user32Symbols>,
  shell32: Deno.DynamicLibrary<typeof shell32Symbols>,
  window: Deno.PointerObject,
): void {
  const large = new BigUint64Array(1);
  const small = new BigUint64Array(1);
  if (shell32.symbols.ExtractIconExW(wide(Deno.execPath()), 0, large, small, 1) === 0) return;
  // The icons stay alive as long as this process, which lasts as long as the window.
  for (const [size, icon] of [[ICON_BIG, large[0]], [ICON_SMALL, small[0]]] as const) {
    if (icon !== 0n) {
      user32.symbols.PostMessageW(window, WM_SETICON, size, Deno.UnsafePointer.create(icon));
    }
  }
}

/**
 * Reopens the compiled release in its own console window when its console went to a terminal.
 * Otherwise gives a console window PetPlay owns PetPlay's name and icon for its taskbar button.
 * @returns true when a reopened PetPlay took over and this process should exit.
 */
export function reopenInOwnConsoleWindow(args: readonly string[]): boolean {
  if (Deno.build.os !== "windows" || !Deno.build.standalone) return false;
  let kernel32: Deno.DynamicLibrary<typeof kernel32Symbols> | null = null;
  let user32: Deno.DynamicLibrary<typeof user32Symbols> | null = null;
  let shell32: Deno.DynamicLibrary<typeof shell32Symbols> | null = null;
  try {
    kernel32 = Deno.dlopen("kernel32.dll", kernel32Symbols);
    user32 = Deno.dlopen("user32.dll", user32Symbols);
    shell32 = Deno.dlopen("shell32.dll", shell32Symbols);
    // More than one process on the console: a shell's console, which stays where it is.
    if (kernel32.symbols.GetConsoleProcessList(new Uint32Array(4), 4) !== 1) return false;
    const window = kernel32.symbols.GetConsoleWindow();
    if (window == null) return false;
    // Told apart by class, not by visibility: a terminal's stand-in window is hidden only until
    // the terminal has shown itself, a quarter of a second after the program started, and
    // reports visible from then on. PetPlay gets here later than that.
    const kind = windowClass(user32, window);
    // A classic console window, PetPlay's own.
    if (kind === CONSOLE_WINDOW_CLASS) {
      kernel32.symbols.SetConsoleTitleW(wide(TITLE));
      setWindowIcon(user32, shell32, window);
      return false;
    }
    // Anything else that is not a terminal's console stays as it is.
    if (kind !== PSEUDO_CONSOLE_WINDOW_CLASS) return false;
    if (Deno.env.get(REOPENED_ENV) != null) return false;
    // Through the shell, not Deno.Command: conhost given standard handles (Deno.Command always
    // passes some) runs headless as a pseudo console instead of opening a window.
    const systemRoot = Deno.env.get("SystemRoot") ?? "C:\\Windows";
    const commandLine = [Deno.execPath(), ...args].map(quoteWindowsArg).join(" ");
    Deno.env.set(REOPENED_ENV, "1");
    const result = shell32.symbols.ShellExecuteW(
      null,
      null,
      wide(`${systemRoot}\\System32\\conhost.exe`),
      wide(commandLine),
      null,
      SW_SHOWNORMAL,
    );
    // Values above 32 mean it started.
    if (Deno.UnsafePointer.value(result) > 32n) return true;
    Deno.env.delete(REOPENED_ENV);
    return false;
  } catch {
    // Stay in whatever console this is.
    return false;
  } finally {
    kernel32?.close();
    user32?.close();
    shell32?.close();
  }
}
