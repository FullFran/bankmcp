import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "http://localhost:8080";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bank-"));
process.env.ATTESTATION_ENABLED = "1";
delete process.env.BANKMCP_PLUGINS;
const { createServer } = await import("../src/mcp.ts");
const { loadPlugins } = await import("../src/mcp.ts");
const { markOwnTransfers } = await import("../src/plugins.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

type Plugins = Awaited<ReturnType<typeof loadPlugins>>;

async function listed(opts: { attestOnly?: boolean; plugins?: Plugins }) {
  const server = createServer(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const prompts = client.getServerCapabilities()?.prompts ? (await client.listPrompts()).prompts : [];
  const hello = tools.some((t) => t.name === "hello") ? await client.callTool({ name: "hello", arguments: {} }) : undefined;
  await client.close();
  return { tools: tools.map((t) => t.name).sort(), prompts: prompts.map((p) => p.name).sort(), hello };
}

function pluginFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plugin-"));
  const path = join(dir, "plugin.ts");
  writeFileSync(path, body);
  return path;
}

const HELLO = `export function register(server, ctx) {
  server.registerTool("hello", { description: "says hi" }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ hi: true, accounts: ctx.accounts().length }) }],
  }));
  server.registerPrompt("hello-prompt", { description: "a prompt" }, () => ({ messages: [] }));
}`;

test("BANKMCP_PLUGINS unset: no plugins, tool and prompt lists unchanged", async () => {
  assert.deepEqual(await loadPlugins(undefined), []);
  assert.deepEqual(await loadPlugins(" "), []);
  const plain = await listed({});
  const empty = await listed({ plugins: [] });
  assert.deepEqual(empty, plain);
  assert.ok(plain.tools.includes("list_accounts"));
});

test("a plugin's tools and prompts are added next to the bank tools, with a working context", async () => {
  const plugins = await loadPlugins(pluginFile(HELLO));
  const plain = await listed({});
  const withPlugin = await listed({ plugins });
  assert.deepEqual(withPlugin.tools, [...plain.tools, "hello"].sort());
  assert.deepEqual(withPlugin.prompts, [...plain.prompts, "hello-prompt"].sort());
  const text = (withPlugin.hello as { content: { text: string }[] }).content[0]!.text;
  assert.deepEqual(JSON.parse(text), { hi: true, accounts: 0 });
});

test("an attestation-only token never sees plugin tools", async () => {
  const plugins = await loadPlugins(pluginFile(HELLO));
  const { tools, prompts } = await listed({ attestOnly: true, plugins });
  assert.deepEqual(tools, ["attest_account"]);
  assert.deepEqual(prompts, []);
});

test("a plugin that cannot be loaded stops startup naming the path", async () => {
  const missing = join(tmpdir(), "no-such-plugin.ts");
  await assert.rejects(loadPlugins(missing), (err: Error) => err.message.includes(missing));
  const noRegister = pluginFile("export const x = 1;");
  await assert.rejects(loadPlugins(noRegister), /does not export a register function/);
});

test("a plugin tool that takes an existing tool's name stops startup", async () => {
  const clash = pluginFile(`export function register(server) {
    server.registerTool("list_accounts", { description: "clash" }, async () => ({ content: [] }));
  }`);
  await assert.rejects(loadPlugins(clash), (err: Error) => err.message.includes(clash) && err.message.includes("list_accounts"));
});

test("markOwnTransfers flags both legs of a transfer between connected accounts", () => {
  const base = { currency: "EUR", status: "BOOK" };
  const list = [
    { ...base, id: "1", date: "2026-11-01", amount: -100, account_uid: "a" },
    { ...base, id: "2", date: "2026-11-01", amount: 100, account_uid: "b" },
    { ...base, id: "3", date: "2026-11-02", amount: -8.89, account_uid: "a", counterparty: "Supermercado" },
    { ...base, id: "4", date: "2026-11-03", amount: -50, account_uid: "a", counterparty_account: "ES00 1111" },
  ];
  const marked = markOwnTransfers(list, ["ES001111"]);
  assert.deepEqual(
    marked.map((t) => [t.id, t.own_transfer]),
    [["1", true], ["2", true], ["3", false], ["4", true]],
  );
});
