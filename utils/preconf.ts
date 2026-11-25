const versionFile = new URL(
  "../submodules/threewebxrwebgpudeno/submodules/iwer/packages/iwer/src/version.ts",
  import.meta.url,
);

try {
  await Deno.stat(versionFile);
} catch {
  await Deno.writeTextFile(versionFile, `export const VERSION = "2.5.0";\n`);
  console.log("Created iwer version.ts stub");
}

const uikitFlexDir = new URL(
  "../submodules/threewebxrwebgpudeno/submodules/uikit/packages/uikit/src/flex/",
  import.meta.url,
);

for (const file of ["setter.ts", "schema.ts"]) {
  const src = new URL(`./preconf/${file}`, import.meta.url);
  const dst = new URL(file, uikitFlexDir);
  try {
    await Deno.stat(dst);
  } catch {
    await Deno.copyFile(src, dst);
    console.log(`Copied ${file} to uikit flex/${file}`);
  }
}
