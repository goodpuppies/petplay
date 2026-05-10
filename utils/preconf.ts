const versionFile = new URL(
  "../submodules/threewebxrwebgpudeno/submodules/iwer/src/version.ts",
  import.meta.url,
);

try {
  await Deno.stat(versionFile);
} catch {
  await Deno.writeTextFile(versionFile, `export const VERSION = "2.2.0";\n`);
  console.log("Created iwer version.ts stub");
}

const setterSrc = new URL("./preconf/setter.ts", import.meta.url);
const setterDst = new URL(
  "../submodules/threewebxrwebgpudeno/submodules/uikit/packages/uikit/src/flex/setter.ts",
  import.meta.url,
);

try {
  await Deno.stat(setterDst);
} catch {
  await Deno.copyFile(setterSrc, setterDst);
  console.log("Copied setter.ts to uikit flex/setter.ts");
}

const iwerDir = new URL(
  "../submodules/threewebxrwebgpudeno/submodules/iwer",
  import.meta.url,
);
const iwerBuild = new URL("build/iwer.module.js", iwerDir);

try {
  await Deno.stat(iwerBuild);
} catch {
  console.log("Building iwer...");
  const npmInstall = new Deno.Command("npm", {
    args: ["install"],
    cwd: iwerDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const installRes = await npmInstall.output();
  if (!installRes.success) {
    throw new Error(`npm install failed in iwer (exit ${installRes.code})`);
  }

  const npmBuild = new Deno.Command("npm", {
    args: ["run", "build"],
    cwd: iwerDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const buildRes = await npmBuild.output();
  if (!buildRes.success) {
    throw new Error(`npm run build failed in iwer (exit ${buildRes.code})`);
  }

  console.log("iwer build complete");
}
