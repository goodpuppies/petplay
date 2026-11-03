/** Bounded raw frame-cost observation; no input injection or metric flushes. */
import { dirname, resolve } from "@std/path";
import { evalIn } from "./vrlab/petplay.ts";

const option = (name: string) =>
  Deno.args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const durationMs = Number(option("duration-ms") ?? 30000);
if (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > 300000) {
  throw Error("duration-ms must be between 100 and 300000");
}
const output = resolve(option("output") ?? `_scratch/perf/frame-observation-${Date.now()}.json`);
const cpuProfile = option("cpu-profile") ? resolve(option("cpu-profile")!) : null;
await Deno.mkdir(dirname(output), { recursive: true });
if (cpuProfile) await Deno.mkdir(dirname(cpuProfile), { recursive: true });
console.log(
  await evalIn(
    "webxr",
    `(async()=>{
  if(globalThis.__vrlabFrameObservation)throw Error('Frame observation already active');
  globalThis.__vrlabFrameObservation=true;
  const libc=Deno.dlopen('libc.so.6',{gettid:{parameters:[],result:'i32'}});
  const workerTid=libc.symbols.gettid();libc.close();
  const startedAt=new Date().toISOString(),started=performance.now();
  const metrics=[...Object.entries(state).filter(([k,v])=>k.endsWith('Metric')&&v&&typeof v.record==='function'),
    ...['xrR3fAdvanceMetric','xrSessionRafWallIntervalMetric'].map(k=>['host.'+k,host[k]])];
  const samples={},restore=[];
  const profilePath=${JSON.stringify(cpuProfile)};
  const profilePromise=profilePath ? (await import(new URL('../classes/denoCpuProfile.ts',moduleUrl).href)).captureDenoCpuProfile({path:profilePath,delayMs:0,durationMs:${durationMs}}) : Promise.resolve();
  try {
    for(const [name,metric] of metrics){
      if(!metric||typeof metric.record!=='function')continue;
      const original=metric.record,descriptor=Object.getOwnPropertyDescriptor(metric,'record');
      const rows=samples[name]=[];
      const wrapped=function(duration){rows.push([performance.now()-started,duration]);return original.call(this,duration);};
      metric.record=wrapped;
      restore.push(()=>{if(metric.record!==wrapped)throw Error('Observation hook replaced: '+name);if(descriptor)Object.defineProperty(metric,'record',descriptor);else delete metric.record;});
    }
    await Promise.all([new Promise(resolve=>setTimeout(resolve,${durationMs})),profilePromise]);
  } finally {
    const errors=[];
    for(const undo of restore.reverse()){try{undo();}catch(e){errors.push(String(e));}}
    delete globalThis.__vrlabFrameObservation;
    if(errors.length)throw Error(errors.join('; '));
  }
  const endedAt=new Date().toISOString();
  const summary=Object.fromEntries(Object.entries(samples).map(([name,rows])=>{
    let maxMs=0,maxIntervalMs=0,sumMs=0;
    rows.forEach(([at,ms],i)=>{sumMs+=ms;maxMs=Math.max(maxMs,ms);if(i)maxIntervalMs=Math.max(maxIntervalMs,at-rows[i-1][0]);});
    const counter=/raylibOvr(BatchGeo|BatchMat|UiPanelCount|UiTextCount|UiPanelDrawn|UiTextDrawn)Metric$/.test(name);
    return [name,{count:rows.length,valueUnit:counter?'count':'ms',avg:rows.length?sumMs/rows.length:null,max:maxMs,maxIntervalMs}];
  }));
  await Deno.writeTextFile(${
      JSON.stringify(output)
    },JSON.stringify({kind:'temporary-frame-metric-observation',startedAt,endedAt,durationMs:${durationMs},elapsedMs:performance.now()-started,workerPid:Deno.pid,workerTid,cpuProfile:profilePath,performanceTimeOrigin:performance.timeOrigin,samples,summary,note:'Temporary record wrappers add observer overhead. Timings include asynchronous pacing and waits where the underlying metric does; they are not exclusively CPU costs. Completion intervals are not presented-pixel freshness. Hooks restored before serialization.'}));
  return {output:${JSON.stringify(output)},summary};
})()`,
    durationMs + 10000,
  ),
);
