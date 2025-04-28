import { PostMan } from "../submodules/stageforge/mod.ts";

import { dirname, join, extname } from "jsr:@std/path";

const state = {

};

new PostMan(state, {
  CUSTOMINIT: (_payload) => { main() },
} as const);

const BUILD = true

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
  // Add more as needed
};

async function main() {

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
    const process = command.spawn();
    await process.status;
  }

}


