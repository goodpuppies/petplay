import { PostMan, wait } from "../submodules/stageforge/mod.ts";

import { dirname, join, extname } from "jsr:@std/path";

const state = {

};

let cefProcess: Deno.ChildProcess | null = null;
let devProcess: Deno.ChildProcess | null = null;

new PostMan(state, {
  CUSTOMINIT: (_payload) => { main() },
} as const);

let BUILD: boolean
if (Deno.args[0] === "dev") {
  BUILD = false
} else {
  BUILD = true
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".vrm": "model/gltf-binary", // Adjust if needed
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

Deno.addSignalListener("SIGINT", () => {
  console.log("Received SIGINT. Cleaning up child processes...");
  try {
    if (cefProcess) {
      console.log("Terminating CEF process...");
      cefProcess.kill("SIGTERM"); // Or "SIGKILL" if SIGTERM is ineffective
      cefProcess = null; // Clear the reference
    }
  } catch (error) {
    console.error("Error terminating CEF process:", error);
  }
  try {
    if (devProcess) {
      console.log("Terminating dev process...");
      devProcess.kill("SIGTERM");
      devProcess = null; // Clear the reference
    }
  } catch (error) {
    console.error("Error terminating dev process:", error);
  }


});

function copyDirectoryContents(sourceDir: string, destDir: string) {
  Deno.mkdirSync(destDir, { recursive: true }); // Ensure destination directory exists

  for (const dirEntry of Deno.readDirSync(sourceDir)) {
    const sourcePath = join(sourceDir, dirEntry.name);
    const destPath = join(destDir, dirEntry.name);

    if (dirEntry.isFile) {
      const fileContent = Deno.readFileSync(sourcePath);
      Deno.writeFileSync(destPath, fileContent);
    } else if (dirEntry.isDirectory) {
      // Recursively copy subdirectory contents
      copyDirectoryContents(sourcePath, destPath);
    }
  }
}

async function cefspawn() {
  const sourceCefDir = join(import.meta.dirname!, "../cef");
  console.log("trymake ", join("./tmp", "cef"))
  Deno.mkdirSync(join("./tmp", "cef"), {recursive: true})
  const tempCefDir = join("./tmp", "cef");

  try {

    Deno.mkdirSync(tempCefDir, { recursive: true });

    console.log(`Copying CEF files from ${sourceCefDir} to ${tempCefDir}`);
    // Use the helper function to copy all contents recursively
    copyDirectoryContents(sourceCefDir, tempCefDir);
    console.log("CEF files copied successfully.");


    // Define the path to the executable within the temporary directory
    const cefExecutablePath = join(tempCefDir, "cefsimple.exe");

    // Check if the executable exists after copying
    try {
      Deno.statSync(cefExecutablePath);
      console.log(`Found executable at: ${cefExecutablePath}`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`Error: cefsimple.exe not found in ${tempCefDir} after copy.`);
        return; // Stop execution if executable is missing
      }
      throw error;
    }

    console.log("EXEC!!!")
    const command = new Deno.Command(cefExecutablePath, {
      args: [],
      // Optionally set the current working directory if cefsimple.exe needs it
      // cwd: tempCefDir,
      stdin: "piped",
      stdout: "inherit", // Inherit stdout to see output
      stderr: "inherit", // Inherit stderr for errors
    });
    cefProcess = command.spawn();

    // Manually close stdin if cefsimple.exe doesn't need input
    cefProcess.stdin.close();

    // Consider waiting for the process to exit or handling its output/errors
    const status = await cefProcess.status;
   console.log(`CEF process exited with code: ${status.code}`);

  } catch (error) {
    console.error("Error during CEF setup or execution:", error);
  }
}

function main() {
  

  if (BUILD) {
    // Assets are expected to be included via `deno compile --include`
    // The base path for included assets relative to the script
    const assetsBasePath = join(import.meta.dirname!, "../dist"); // 'dist' is the included folder name

    //console.log(`Serving included assets from: ${assetsBasePath}`);
    Deno.serve({ port: 5173 }, async (req: Request) => {
      const url = new URL(req.url);
      let pathname = url.pathname;

      // Default to index.html for root or SPA routes without file extensions
      if (pathname === "/" || !extname(pathname)) { // Corrected condition
        pathname = "/index.html";
      }

      // Construct the full path to the potential file within the included assets
      const filePath = join(assetsBasePath, pathname);

      try {
        const fileContent = await Deno.readFile(filePath);
        const ext = extname(pathname); // Get extension from the potentially modified pathname
        const contentType = mimeTypes[ext] || "application/octet-stream";

        return new Response(fileContent, {
          headers: { "Content-Type": contentType },
        });
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          // If the specific file wasn't found, try serving index.html as a fallback for SPA routing
          // This handles cases where a non-root SPA route was requested but index.html should be served
          if (pathname !== "/index.html") { // Avoid infinite loop if index.html itself is missing
            try {
              const indexPath = join(assetsBasePath, "index.html");
              const indexContent = await Deno.readFile(indexPath);
              return new Response(indexContent, {
                headers: { "Content-Type": "text/html" },
              });
            } catch (indexError) {
              if (indexError instanceof Deno.errors.NotFound) {
                console.error(`Not Found: ${pathname} (and index.html fallback failed)`);
                return new Response("404: Not Found", { status: 404 });
              }
              console.error(`Error reading index.html fallback: ${indexError}`);
              return new Response("500: Internal Server Error", { status: 500 });
            }
          } else {
            // This means index.html itself was requested but not found
            console.error(`Not Found: ${pathname}`);
            return new Response("404: Not Found", { status: 404 });
          }
        } else {
          console.error(`Error reading file ${filePath}: ${error}`);
          return new Response("500: Internal Server Error", { status: 500 });
        }
      }
    });
    //console.log("Server listening on http://localhost:5173");
  } else {
    const command = new Deno.Command("deno", {
      args: ["task", "dev"],
      cwd: "./submodules/frontend", // or the absolute path if needed
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    devProcess = command.spawn();
  }

  cefspawn()

  

}


