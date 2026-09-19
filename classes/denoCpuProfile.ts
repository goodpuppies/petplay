import { Session } from "node:inspector";

type InspectorResult = Record<string, unknown>;

function postInspectorCommand(
  session: Session,
  method: string,
): Promise<InspectorResult> {
  return new Promise((resolve, reject) => {
    session.post(method, (error, result) => {
      if (error != null) {
        reject(error);
      } else {
        resolve(result as InspectorResult);
      }
    });
  });
}

/** Capture the current Deno isolate, which matters for worker-heavy applications. */
export async function captureDenoCpuProfile(options: {
  path: string;
  delayMs: number;
  durationMs: number;
  log?: (message: string) => void;
}): Promise<void> {
  if (options.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  const session = new Session();
  session.connect();
  try {
    await postInspectorCommand(session, "Profiler.enable");
    await postInspectorCommand(session, "Profiler.start");
    options.log?.(
      `CPU profile started duration=${options.durationMs}ms path=${options.path}`,
    );
    await new Promise((resolve) => setTimeout(resolve, options.durationMs));
    const result = await postInspectorCommand(session, "Profiler.stop");
    await Deno.writeTextFile(options.path, JSON.stringify(result.profile));
    options.log?.(`CPU profile written path=${options.path}`);
  } finally {
    session.disconnect();
  }
}
