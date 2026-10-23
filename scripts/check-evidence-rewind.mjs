import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyRewind, getDraft, planRewind } from "../lib/rewind.js";

// Use in-memory databases and a temporary host tool registry. No live DSH data is used.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-evidence-rewind-"));
const oldHome = process.env.DSH_HOME;
const databases = new Map();
process.env.DSH_HOME = temp;
let groups = 0;
function passed(label) {
  groups += 1;
  console.log("PASS " + label);
}

try {
  const stub = path.join(temp, "node_modules", "@deepseek-ai", "dsh-tools");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(temp, "package.json"), "{}");
  fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify({ main: "index.cjs" }));
  fs.writeFileSync(path.join(stub, "index.cjs"), "exports.defineTool = (spec) => spec;\n");
  const { apply } = await import("../lib/redteam/tools.js");
  const registered = new Map();
  const store = {
    db(id) {
      if (!databases.has(id)) {
        const db = new DatabaseSync(":memory:");
        db.exec("CREATE TABLE existing_data(value TEXT); INSERT INTO existing_data VALUES ('retained')");
        databases.set(id, db);
      }
      return databases.get(id);
    },
  };
  apply({
    redteam: store,
    tools: { register(tool) { assert.ok(!registered.has(tool.name)); registered.set(tool.name, tool); } },
    effect(fn) { fn(); },
    on() { return () => {}; },
  });
  const call = async (name, args = {}) => JSON.parse(await registered.get(name).execute({ engagement: "fixture-a", ...args }, {}));
  for (const name of ["redteam_evidence_record", "redteam_evidence_verify", "redteam_evidence_upgrade", "redteam_evidence_list", "redteam_unverified_count", "redteam_unknown_record", "redteam_unknown_resolve", "redteam_unknown_list", "redteam_poc_search", "redteam_poc_get"]) {
    assert.ok(registered.has(name), name);
  }
  passed("evidence tools register alongside existing knowledge-base tools");

  const claim = { operation: "fixture_check", parameters: { a: 1, b: 2 }, result: { present: true }, confidence: "claimed", authority: "subagent-report" };
  const recorded = await call("redteam_evidence_record", claim);
  assert.equal(recorded.ok, true);
  const duplicate = await call("redteam_evidence_record", { ...claim, parameters: { b: 2, a: 1 } });
  assert.equal(duplicate.ev_id, recorded.ev_id);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await call("redteam_evidence_verify", claim)).matched, true);
  assert.equal((await call("redteam_evidence_verify", { ...claim, result: { present: false } })).matched, false);
  assert.equal((await call("redteam_unverified_count")).unverified_count, 1);
  assert.equal((await call("redteam_evidence_record", { ...claim, confidence: "invalid" })).ok, false);
  passed("evidence hashing, deduplication, mismatches, and validation");

  const upgraded = await call("redteam_evidence_upgrade", { claimed_ev_id: recorded.ev_id, verified_result: { present: true, checked: true } });
  assert.equal(upgraded.ok, true);
  const items = (await call("redteam_evidence_list")).items;
  assert.equal(items.length, 2);
  assert.ok(items.find((item) => item.confidence === "observed").supporting_ev_ids.includes(recorded.ev_id));
  assert.equal((await call("redteam_unverified_count")).unverified_count, 0);
  assert.equal((await call("redteam_evidence_list", { engagement: "fixture-b" })).items.length, 0);
  assert.equal(store.db("fixture-a").prepare("SELECT value FROM existing_data").get().value, "retained");
  passed("verified upgrades retain audit history and target isolation");

  const unknown = await call("redteam_unknown_record", { question: "Is the fixture complete?", domain: "fixture" });
  assert.equal(unknown.ok, true);
  assert.equal((await call("redteam_unknown_record", { question: "Is the fixture complete?", domain: "fixture" })).duplicate, true);
  assert.equal((await call("redteam_unknown_list")).items.length, 1);
  assert.equal((await call("redteam_unknown_resolve", { unk_id: unknown.unk_id, disposition: "resolved", resolution: "Fixture inspected" })).ok, true);
  assert.equal((await call("redteam_unknown_list")).items.length, 0);
  assert.equal((await call("redteam_unknown_list", { status: "resolved" })).items.length, 1);
  passed("unknown questions deduplicate, resolve, and filter");

  const event = (type, data = {}) => ({ type, data });
  const numbered = (events) => events.map((item, seq) => ({ ...item, seq }));
  const history = numbered([
    event("system/message"), event("turn/start", { turn: 1 }),
    event("user/message", { content: "Fixture prompt", source: { kind: "user" } }),
    event("step/start", { turn: 1, step: 1 }), event("assistant/message"), event("step/end"),
    event("step/start", { turn: 1, step: 2 }), event("assistant/message"), event("step/end"), event("turn/end", { turn: 1 }),
  ]);
  assert.equal(planRewind(history, "once").atSeq, 5);
  assert.equal(planRewind(history, "round").atSeq, 0);
  assert.equal(planRewind(history, "round").text, "Fixture prompt");
  assert.equal(planRewind([], "once").ok, false);
  passed("step and turn planning use distinct inclusive fork boundaries");

  function host(events) {
    const sessions = new Map([["main", { header: { cwd: "C:/fixture" }, snapshotEvents: () => events }]]);
    const archived = [], cancelled = [], forks = [], created = [], queue = [];
    const agent = { phase: { kind: "idle" }, inbox: { nextTurn: [{ id: "pending" }], nextStep: [] }, requestHeaderLogged: true, requestSurfaceGeneration: 5, frozenMessages: new Map([["old", true]]), cancel() { throw new Error("New session must not be cancelled"); } };
    function addChild(childEvents) {
      const id = "rewound-" + sessions.size;
      sessions.set(id, { header: { cwd: "C:/fixture" }, snapshotEvents: () => childEvents });
      return { sessionId: id };
    }
    const services = {
      sessions: { get: (id) => sessions.get(id) },
      agents: { get: () => agent },
      workspaceRegistry: {
        list: () => [{ id: "workspace", path: "C:/fixture", sessionIds: [...sessions.keys()] }],
        archiveSession: async (id) => archived.push(id),
        get: () => ({ detachSession() {} }),
      },
      sessionController: {
        fork: async (args) => { forks.push(args); return addChild(events.slice(0, args.atSeq + 1)); },
        create: async (args) => { created.push(args); return addChild([]); },
        cancel: async ({ sessionId }) => cancelled.push(sessionId),
        updateQueue: async (args) => queue.push(args),
      },
    };
    return { ctx: { get: (name) => services[name] }, sessions, archived, cancelled, forks, created, queue, agent };
  }

  const once = host(history);
  const step = await applyRewind(once.ctx, "main", "once");
  assert.equal(step.ok, true);
  assert.notEqual(step.sessionId, "main");
  assert.deepEqual(once.forks, [{ sessionId: "main", atSeq: 5 }]);
  assert.deepEqual(once.archived, ["main"]);
  assert.equal(once.sessions.get(step.sessionId).snapshotEvents().length, 6);
  assert.equal(once.sessions.get("main").snapshotEvents().length, 10);
  assert.equal(once.agent.requestHeaderLogged, false);
  assert.equal(once.agent.frozenMessages.size, 0);
  assert.equal(once.queue[0].itemId, "pending");
  passed("step rewind forks, preserves source history, clears queue, and resets requests");

  const round = host(history);
  const turn = await applyRewind(round.ctx, "main", "round");
  assert.equal(turn.ok, true);
  assert.deepEqual(round.forks, [{ sessionId: "main", atSeq: 0 }]);
  assert.equal(getDraft(turn.sessionId).text, "Fixture prompt");
  passed("turn rewind preserves earlier context and returns the prompt as a draft");

  const blank = host(numbered([event("user/message", { content: "First prompt" })]));
  const first = await applyRewind(blank.ctx, "main", "round");
  assert.equal(first.ok, true);
  assert.deepEqual(blank.created, [{ workspaceId: "workspace" }]);
  assert.equal(first.text, "First prompt");
  passed("rewinding the first message creates a blank workspace session");

  const familyHistory = numbered([
    event("system/message"), event("turn/start", { turn: 1 }), event("subagent/catalog", { childId: "old-child" }), event("turn/end", { turn: 1 }),
    event("turn/start", { turn: 2 }), event("user/message", { content: "New prompt" }),
    event("step/start", { turn: 2, step: 1 }), event("subagent/catalog", { childId: "new-child" }), event("turn/end", { turn: 2 }),
  ]);
  const family = host(familyHistory);
  family.sessions.set("new-child", { header: { origin: "subagent", parentSession: "main" }, snapshotEvents: () => [] });
  const result = await applyRewind(family.ctx, "new-child", "round");
  assert.equal(result.ok, true);
  assert.equal(result.parentId, "main");
  assert.ok(family.cancelled.includes("new-child"));
  assert.ok(family.archived.includes("new-child"));
  assert.ok(!family.archived.includes("old-child"));
  assert.equal(family.forks.length, 1);
  passed("round rewind resolves the parent and archives only the selected turn's subagents");

  const unavailable = await applyRewind({ get: () => undefined }, "missing", "once");
  assert.equal(unavailable.ok, false);
  passed("missing host rewind APIs return a structured failure");
  console.log(`ALL PASS (${groups} groups)`);
} finally {
  for (const db of databases.values()) db.close();
  if (oldHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = oldHome;
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
