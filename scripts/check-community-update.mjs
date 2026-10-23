import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise real updater entry points against disposable Git/profile fixtures.
// All HTTP requests are intercepted; the real host and its settings are untouched.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-community-update-"));
const repo = "realMisakaMikoto/dsh-purge";
const gitUrl = `https://github.com/${repo}.git`;
const requests = [];
const requestBefore = https.request;
const homeBefore = process.env.DSH_HOME;
process.env.DSH_HOME = path.join(temp, "home");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function copyPlugin(dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(root, "lib"), path.join(dest, "lib"), { recursive: true });
  fs.cpSync(path.join(root, "presets"), path.join(dest, "presets"), { recursive: true });
  const fixturePackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  fixturePackage.version = "1.1.72";
  fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify(fixturePackage, null, 2));
  fs.copyFileSync(path.join(root, "NOTICE"), path.join(dest, "NOTICE"));
  fs.writeFileSync(path.join(dest, "lib", "reapply-cli.js"),
    'console.log(JSON.stringify({ok:false,error:"fixture: skip host mutation"}));\n');
}

try {
  const source = path.join(temp, "community");
  const live = path.join(temp, "git-install");
  copyPlugin(source);
  git(source, "init", "-b", "master");
  git(source, "config", "user.name", "Updater regression");
  git(source, "config", "user.email", "updater@example.invalid");
  fs.writeFileSync(path.join(source, "lib", "update-fixture.txt"), "old");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial fixture");
  execFileSync("git", ["clone", "--quiet", source, live], { windowsHide: true });
  const originalOrigin = path.join(temp, "unused-origin.git");
  git(live, "remote", "set-url", "origin", originalOrigin);
  git(live, "config", `url.${source.replace(/\\/g, "/")}.insteadOf`, gitUrl);
  fs.writeFileSync(path.join(source, "lib", "update-fixture.txt"), "community");
  fs.appendFileSync(path.join(source, "presets", "redteam", "preset.yml"), "\n# community update fixture\n");
  fs.appendFileSync(path.join(source, "NOTICE"), "\nCommunity update fixture\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "Community update fixture");
  git(source, "tag", "v1.1.73");
  const sha = git(source, "rev-parse", "HEAD");
  const zip = execFileSync("git", ["-C", source, "archive", "--format=zip", "--prefix=dsh-fixture/", "HEAD"], {
    windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });

  https.request = (url, options, callback) => {
    const address = String(url);
    requests.push(address);
    assert.ok(address.includes(repo), `Unexpected update repository: ${address}`);
    let status = 200;
    let body;
    if (address.includes("codeload.github.com/")) body = zip;
    else if (/\/commits\/master$/.test(address)) body = JSON.stringify({ sha });
    else if (/\/commits\/master\.atom$/.test(address)) body = `<id>tag:github.com,2008:Grit::Commit/${sha}</id>`;
    else if (address.includes("/commits/beta")) { status = 404; body = "not found"; }
    else if (address.includes("/tags?")) body = "[]";
    else if (address.includes("package.json")) body = JSON.stringify({ version: "1.1.73" });
    else throw new Error(`Unexpected request: ${address}`);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => req.emit("error", error);
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = {};
      res.resume = () => {};
      callback(res);
      res.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(body));
      res.emit("end");
    });
    return req;
  };

  const updater = await import(pathToFileURL(path.join(live, "lib", "update.js")).href);
  const check = await updater.checkUpdate();
  assert.equal(check.remoteVersion, "1.1.73");
  assert.equal(check.remoteSha, sha.slice(0, 7));
  assert.equal(check.hasUpdate, true);
  console.log("PASS version checks use the community repository");

  const updatedGit = await updater.applyUpdate([{ kind: "git", dir: live }], { ref: "master", pin: false });
  assert.equal(updatedGit.via, "git");
  assert.equal(fs.readFileSync(path.join(live, "lib", "update-fixture.txt"), "utf8"), "community");
  assert.equal(git(live, "remote", "get-url", "origin"), originalOrigin);
  console.log("PASS Git updates fetch the community source and retain origin");

  fs.writeFileSync(path.join(live, "lib", "update-fixture.txt"), "tag fixture");
  await updater.applyUpdate([{ kind: "git", dir: live }], { ref: "v1.1.73", pin: "v1.1.73" });
  assert.equal(git(live, "rev-parse", "HEAD"), sha);
  assert.equal(fs.readFileSync(path.join(live, "lib", "update-fixture.txt"), "utf8"), "community");
  console.log("PASS pinned tags resolve from the community source");

  const archive = path.join(temp, "archive-install");
  const installed = path.join(temp, "profile-install");
  const profile = path.join(temp, "profile");
  copyPlugin(archive);
  copyPlugin(installed);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dependencies: { "dsh-purge": "old-source" } }));
  const updatedArchive = await updater.applyUpdate([
    { kind: "zip", dir: archive },
    { kind: "dsh", dir: installed, profileDir: profile },
  ], { ref: "master", pin: false });
  assert.equal(updatedArchive.via, "zip");
  for (const dir of [archive, installed]) {
    assert.equal(fs.readFileSync(path.join(dir, "lib", "update-fixture.txt"), "utf8"), "community");
    assert.ok(fs.readFileSync(path.join(dir, "presets", "redteam", "preset.yml"), "utf8").includes("# community update fixture"));
    assert.ok(fs.readFileSync(path.join(dir, "NOTICE"), "utf8").includes("Community update fixture"));
  }
  const spec = JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8")).dependencies["dsh-purge"];
  assert.equal(spec, `https://codeload.github.com/${repo}/tar.gz/refs/heads/master`);
  assert.ok(requests.some((url) => url === `https://codeload.github.com/${repo}/zip/refs/heads/master`));
  console.log("PASS archive downloads and profile specs use the community repository");
  console.log("ALL PASS");
} finally {
  https.request = requestBefore;
  if (homeBefore === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = homeBefore;
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
