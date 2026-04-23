#!/usr/bin/env -S deno run -A

/**
 * Type check runner that filters out errors from specific paths.
 * Run with: deno run -A utils/type-check.ts
 */

const IGNORE_PATHS = [
  "/submodules/threewebxrwebgpudeno/submodules/",
  "/submodules/threewebxrwebgpudeno/local-uikit/",
];

async function runTypeCheck(): Promise<void> {
  console.log("Running deno check --allow-import...\n");

  const command = new Deno.Command("deno", {
    args: ["check", "--allow-import"],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();
  const output = new TextDecoder().decode(stdout);
  const errors = new TextDecoder().decode(stderr);

  // Deno check outputs both "Check" lines and errors to stderr
  const fullOutput = errors;

  if (code === 0 && !fullOutput.trim()) {
    console.log("✅ No type errors found!");
    return;
  }

  const { filteredOutput, totalErrors, filteredErrors } = filterDiagnostics(fullOutput);
  const remainingErrors = totalErrors - filteredErrors;

  if (!filteredOutput.trim()) {
    console.log(`✅ No type errors found (after filtering ignored paths)`);
    console.log(`(Filtered out ${filteredErrors} error${filteredErrors !== 1 ? 's' : ''})`);
    return;
  }

  console.log(filteredOutput);
  console.log(`\nShowing ${remainingErrors} error${remainingErrors !== 1 ? 's' : ''} (${filteredErrors} filtered out)`);
  Deno.exit(1);
}

function shouldIgnoreBlock(block: string): boolean {
  return IGNORE_PATHS.some((prefix) => block.includes(prefix));
}

function filterDiagnostics(output: string): { filteredOutput: string; totalErrors: number; filteredErrors: number } {
  // Extract total error count from "Found X errors." line
  const foundMatch = output.match(/Found (\d+) errors?\./);
  const totalErrors = foundMatch ? parseInt(foundMatch[1], 10) : 0;

  // Split output by lines containing TS\d+ [ERROR]:
  const lines = output.split("\n");
  const blocks: string[] = [];
  let currentBlock = "";

  for (const line of lines) {
    if (/TS\d+/.test(line) && line.includes("[ERROR]:")) {
      // Start of new error block
      if (currentBlock) {
        blocks.push(currentBlock.trim());
      }
      currentBlock = line;
    } else if (currentBlock) {
      // Continuation of current error block
      currentBlock += "\n" + line;
    }
  }

  // Don't forget the last block
  if (currentBlock) {
    blocks.push(currentBlock.trim());
  }

  const filteredBlocks = blocks.filter((block) => {
    return !shouldIgnoreBlock(block);
  });

  const remainingErrors = filteredBlocks.length;
  const filteredErrors = totalErrors - remainingErrors;

  if (filteredBlocks.length === 0) {
    return { filteredOutput: "", totalErrors, filteredErrors };
  }

  // Join blocks with single blank line separator
  const result = filteredBlocks.join("\n\n");

  return { filteredOutput: result, totalErrors, filteredErrors };
}

if (import.meta.main) {
  await runTypeCheck();
}
