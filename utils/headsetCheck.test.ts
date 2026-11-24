import { assertEquals } from "@std/assert";
import { answerFromStick, type CheckStep, runSteps } from "./headsetCheck.ts";

Deno.test("answerFromStick: up yes, down no, left skip, middle nothing", () => {
  assertEquals(answerFromStick(0, 0.9), "yes");
  assertEquals(answerFromStick(0, -0.9), "no");
  assertEquals(answerFromStick(-0.9, 0), "skip");
  assertEquals(answerFromStick(0.9, 0), null);
  assertEquals(answerFromStick(0.3, -0.5), null);
});

Deno.test("runSteps: undoes each setup after its answer, in order", async () => {
  const log: string[] = [];
  const step = (id: string): CheckStep => ({
    id,
    question: id,
    setup: () => {
      log.push(`setup ${id}`);
      return () => log.push(`undo ${id}`);
    },
  });
  const results = await runSteps([step("a"), step("b")], (s) => {
    log.push(`ask ${s.id}`);
    return Promise.resolve(s.id === "a" ? "yes" : "no");
  });
  assertEquals(log, ["setup a", "ask a", "undo a", "setup b", "ask b", "undo b"]);
  assertEquals(results.map((r) => r.answer), ["yes", "no"]);
});

Deno.test("runSteps: a failing step is a skip, and the run goes on", async () => {
  const undone: string[] = [];
  const results = await runSteps([
    {
      id: "broken-setup",
      question: "",
      setup: () => {
        throw new Error("no display");
      },
    },
    {
      id: "broken-ask",
      question: "",
      setup: () => () => undone.push("broken-ask"),
    },
    { id: "fine", question: "" },
  ], (s) => s.id === "broken-ask" ? Promise.reject(new Error("gone")) : Promise.resolve("yes"));
  assertEquals(results.map((r) => r.answer), ["skip", "skip", "yes"]);
  assertEquals(undone, ["broken-ask"]);
});

Deno.test("runSteps: settles after each undo, before the next setup", async () => {
  const log: string[] = [];
  const step = (id: string): CheckStep => ({
    id,
    question: id,
    setup: () => {
      log.push(`setup ${id}`);
      return () => log.push(`undo ${id}`);
    },
  });
  await runSteps([step("a"), step("b")], () => Promise.resolve("yes"), () => {
    log.push("settle");
    return Promise.resolve();
  });
  assertEquals(log, ["setup a", "undo a", "settle", "setup b", "undo b", "settle"]);
});
