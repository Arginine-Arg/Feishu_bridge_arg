import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProcessInvocation, resolveCodexProcess } from "./codex-process.js";
import { BrokerError, errorMessage } from "./errors.js";
import { JsonLinePeer, JsonRpcRemoteError } from "./jsonrpc.js";
const ROUTE = "broker-worker";
const MAX_EVENTS = 1024;
const MAX_OUTPUT = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const START_TIMEOUT = 25_000;
const STOP_GRACE = 5_000;
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export class DshRuntime extends EventEmitter {
    metadata;
    directory;
    environment;
    #agents = new Map();
    #children = new Set();
    #opening = new Set();
    #stopping = false;
    revision = 0;
    constructor(metadata, directory, environment) {
        super();
        this.metadata = metadata;
        this.directory = directory;
        this.environment = environment;
    }
    async startAgent(task, cwd) {
        const homeId = randomUUID();
        return this.#open(cwd, homeId, async (connection) => {
            const result = record(await connection.peer.request("session/new", { cwd, mcpServers: [] }, START_TIMEOUT));
            const id = result.sessionId;
            if (typeof id !== "string" || !SESSION_ID.test(id))
                throw new Error("DSH returned an invalid session id");
            connection.sessionId = id;
            this.#verifyModel(result);
            const agent = {
                id, homeId, cwd, status: "starting", output: "", cursor: 0, events: [], droppedThrough: 0, outputChars: 0,
            };
            await this.#persist(agent);
            this.#agents.set(id, agent);
            this.#run(connection, agent, task);
            return this.#snapshot(agent);
        });
    }
    async send(id, task) {
        const agent = await this.#restore(id);
        if (agent.operation)
            throw new BrokerError("invalid_input", "Finish or interrupt the active DSH turn before sending a follow-up");
        if (await realpath(agent.cwd) !== agent.cwd)
            throw new BrokerError("invalid_workspace", "The worker workspace has changed on disk");
        if (agent.operation)
            throw new BrokerError("invalid_input", "The DSH worker already has an active request");
        // Reserve the slot before the first async process operation. Concurrent
        // Broker processes are additionally serialized by DSH's writer lease.
        const opening = this.#open(agent.cwd, agent.homeId, async (connection) => {
            const result = record(await connection.peer.request("session/resume", {
                sessionId: id, cwd: agent.cwd, mcpServers: [],
            }, START_TIMEOUT));
            connection.sessionId = id;
            this.#verifyModel(result);
            agent.status = "starting";
            agent.output = "";
            delete agent.error;
            await this.#persist(agent);
            this.#run(connection, agent, task);
            return this.#snapshot(agent);
        });
        agent.operation = opening.then(() => { }, () => { });
        try {
            return await opening;
        }
        finally {
            if (!agent.cancel)
                delete agent.operation;
        }
    }
    async snapshotFor(id) { return this.#snapshot(await this.#restore(id)); }
    takeInteraction() { return undefined; }
    async interrupt(id) {
        const agent = await this.#restore(id);
        const previousStatus = agent.status;
        const opening = agent.operation;
        if (opening && !agent.cancel)
            await opening;
        agent.cancel?.();
        await agent.operation;
        return { previousStatus, agent: this.#snapshot(agent) };
    }
    async listThreads() {
        const files = await readdir(path.join(this.directory, "agents")).catch(error => {
            if (error.code === "ENOENT")
                return [];
            throw error;
        });
        return files.filter(file => file.endsWith(".json") && SESSION_ID.test(file.slice(0, -5)))
            .map(file => ({ id: file.slice(0, -5) }));
    }
    async readEvents(id, cursor, maxEvents, waitMs, signal) {
        const agent = await this.#restore(id);
        if (agent.cursor <= cursor && agent.operation && waitMs > 0) {
            if (signal?.aborted)
                throw new BrokerError("wait_cancelled", "read_agent_events was cancelled");
            await new Promise((resolve, reject) => {
                const finish = () => {
                    clearTimeout(timer);
                    this.off("update", finish);
                    signal?.removeEventListener("abort", onAbort);
                    if (signal?.aborted)
                        reject(new BrokerError("wait_cancelled", "read_agent_events was cancelled"));
                    else
                        resolve();
                };
                const onAbort = () => finish();
                const timer = setTimeout(finish, waitMs);
                this.once("update", finish);
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
        const events = agent.events.filter(event => event.seq > cursor).slice(0, maxEvents);
        return {
            events,
            nextCursor: events.at(-1)?.seq ?? Math.max(cursor, agent.cursor),
            eventCursor: agent.cursor,
            cursorExpired: cursor < agent.droppedThrough,
            droppedThrough: agent.droppedThrough,
            status: agent.status,
            done: agent.status !== "starting" && agent.status !== "running",
        };
    }
    async stop() {
        this.#stopping = true;
        for (const agent of this.#agents.values())
            agent.cancel?.();
        await Promise.allSettled([...this.#children].filter(child => !child.active).map(child => child.close()));
        await Promise.allSettled(this.#opening);
        await Promise.allSettled([...this.#agents.values()].map(agent => agent.operation));
    }
    async #open(cwd, homeId, action) {
        if (this.#stopping)
            throw new Error("DSH runtime is closing");
        const opening = this.#prepare(cwd, homeId, action);
        this.#opening.add(opening);
        try {
            return await opening;
        }
        finally {
            this.#opening.delete(opening);
        }
    }
    async #prepare(cwd, homeId, action) {
        const route = this.metadata.route;
        const dsh = route.dsh;
        const env = { ...this.environment };
        const key = route.envKey && env[route.envKey];
        if (!key)
            throw new BrokerError("credential_missing", "The DSH worker route has no API key");
        const headers = [];
        for (const [header, variable] of Object.entries(route.envHttpHeaders)) {
            const value = env[variable];
            if (!value)
                throw new BrokerError("credential_missing", `The DSH worker route is missing ${variable}`);
            const ref = `DSH_BROKER_SECRET_HEADER_${headers.length}`;
            headers.push([header, ref]);
            env[ref] = value;
        }
        for (const variable of [route.envKey, ...Object.values(route.envHttpHeaders)])
            delete env[variable];
        env.DSH_BROKER_SECRET_KEY = key;
        const privateState = path.join(this.directory, "harness", homeId);
        const home = path.join(privateState, "home");
        await mkdir(home, { recursive: true, mode: 0o700 });
        env.DSH_HOME = await realpath(home);
        env.DSH_TELEMETRY_DISABLED = "1";
        env.DSH_PERMISSION_MODE = this.metadata.access;
        const patch = path.join(this.directory, "worker.yml");
        const selection = { provider: ROUTE, model: route.model };
        const profile = {
            api: dsh.api, baseURL: route.baseUrl, displayName: route.providerName,
            apiKeyEnv: "DSH_BROKER_SECRET_KEY",
            models: [{ id: route.model, ...(route.contextWindow ? { contextWindow: route.contextWindow } : {}) }],
        };
        const config = `({providers:{[${JSON.stringify(ROUTE)}]:{...${JSON.stringify(profile)},headers:Object.fromEntries(${JSON.stringify(headers)}.map(([name, ref])=>[name,process.env[ref]]))}}})`;
        const disabled = [
            "tool-subagent", "tool-subagent-fork", "tool-subagent-control",
            "tool-plugin-manager", "tool-goal", "goal-round-driver", "tool-workflow",
        ];
        if (!route.tags.includes("web-search:enabled"))
            disabled.push("tool-web");
        await this.#write(patch, [
            "- id: llm-pi-ai", `  config: !!js ${JSON.stringify(config)}`,
            `- id: acp\n  config: ${JSON.stringify(selection)}`,
            `- id: agent-default-model\n  config: ${JSON.stringify(selection)}`,
            ...disabled.map(id => `- id: ${id}\n  disabled: true`),
            "",
        ].join("\n"));
        await this.#write(path.join(this.directory, "runtime.json"), JSON.stringify(this.metadata));
        if (this.#stopping)
            throw new Error("DSH runtime is closing");
        const scratch = await mkdtemp(path.join(await realpath(privateState), "tmp-"));
        env.TMPDIR = env.TMP = env.TEMP = scratch;
        const writablePaths = [env.DSH_HOME, scratch];
        if (this.metadata.access === "workspace-write")
            writablePaths.push(cwd);
        let connection;
        try {
            if (this.#stopping)
                throw new Error("DSH runtime is closing");
            connection = new WorkerConnection(dsh.binary, cwd, env, patch, writablePaths, this.metadata.access);
        }
        catch (error) {
            await rm(scratch, { recursive: true, force: true });
            throw error;
        }
        this.#children.add(connection);
        void connection.exited.then(async () => {
            this.#children.delete(connection);
            await rm(scratch, { recursive: true, force: true }).catch(() => { });
        });
        try {
            const result = record(await connection.peer.request("initialize", { protocolVersion: 1 }, START_TIMEOUT));
            const capabilities = record(record(result.agentCapabilities).sessionCapabilities);
            if (result.protocolVersion !== 1 || !capabilities.close || !capabilities.resume) {
                throw new Error("DSH must support ACP 1 session resume and close");
            }
            return await action(connection);
        }
        catch (error) {
            await connection.close();
            throw new BrokerError("dsh_acp", connection.safeError(error));
        }
    }
    #verifyModel(result) {
        const expected = JSON.stringify([ROUTE, this.metadata.route.model]);
        if (!Array.isArray(result.configOptions) || !result.configOptions.some(value => {
            const option = record(value);
            return option.id === "model" && option.currentValue === expected;
        }))
            throw new BrokerError("route_mismatch", `DSH did not confirm the configured model ${this.metadata.route.model}`);
    }
    #run(connection, agent, task) {
        connection.active = true;
        let interrupted = false;
        agent.status = "running";
        agent.cancel = () => { interrupted = true; connection.cancel(); };
        this.#event(agent, { type: "turn_started" });
        connection.peer.setNotificationHandler((method, params) => {
            const value = record(params);
            if (method !== "session/update" || value.sessionId !== agent.id)
                return;
            const update = record(value.update);
            const content = record(update.content);
            const safeText = typeof content.text === "string" ? connection.redact(content.text).slice(0, MAX_OUTPUT) : "";
            const itemId = typeof update.messageId === "string" ? update.messageId : undefined;
            if (update.sessionUpdate === "agent_message_chunk" && content.type === "text") {
                agent.output = (agent.output + safeText).slice(-MAX_OUTPUT);
                this.#event(agent, { type: "text_delta", text: safeText, ...(itemId ? { itemId } : {}) });
            }
            else if (update.sessionUpdate === "agent_thought_chunk" && content.type === "text") {
                this.#event(agent, { type: "reasoning_summary_delta", text: safeText });
            }
            else if (update.sessionUpdate === "tool_call" || (update.sessionUpdate === "tool_call_update" && ["completed", "failed"].includes(String(update.status)))) {
                const toolId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
                this.#event(agent, { type: update.sessionUpdate === "tool_call" ? "tool_started" : "tool_completed",
                    ...(typeof update.title === "string" ? { tool: connection.redact(update.title).slice(0, 200) } : {}),
                    ...(toolId ? { itemId: toolId } : {}) });
            }
        });
        agent.operation = (async () => {
            let status;
            try {
                const result = record(await connection.peer.request("session/prompt", {
                    sessionId: agent.id, prompt: [{ type: "text", text: task }],
                }, 0));
                status = interrupted || result.stopReason === "cancelled" ? "interrupted" : "completed";
            }
            catch (error) {
                status = interrupted ? "interrupted" : "failed";
                if (!interrupted)
                    agent.error = connection.safeError(error);
            }
            if (interrupted)
                status = "interrupted";
            if (status !== "completed")
                agent.output = "";
            try {
                await this.#persist(agent, status, agent.cursor + 1);
            }
            catch (error) {
                status = "failed";
                agent.error = `Could not save the latest DSH worker result: ${connection.safeError(error)}`;
            }
            finally {
                await connection.close();
                agent.status = status;
                delete agent.operation;
                delete agent.cancel;
                this.#event(agent, { type: "turn_completed", status });
            }
        })();
    }
    #event(agent, event) {
        agent.events.push({ ...event, seq: ++agent.cursor });
        agent.outputChars += event.text?.length ?? 0;
        while (agent.events.length > MAX_EVENTS || agent.outputChars > MAX_OUTPUT) {
            const removed = agent.events.shift();
            agent.droppedThrough = removed.seq;
            agent.outputChars -= removed.text?.length ?? 0;
        }
        this.#update();
    }
    #update() { this.revision++; this.emit("update"); }
    #snapshot(agent) {
        const { route, runtimeId } = this.metadata;
        return {
            agentId: `broker:${runtimeId}:${agent.id}`, route: route.id, provider: route.provider, model: route.model,
            backend: "dsh_acp", status: agent.status, eventCursor: agent.cursor, eventStream: "events-v1",
            ...(agent.status === "completed" ? { output: agent.output } : {}),
            ...(agent.status === "failed" && agent.error ? { error: agent.error } : {}),
        };
    }
    async #restore(id) {
        if (!SESSION_ID.test(id))
            throw new BrokerError("invalid_agent", "Invalid DSH worker id");
        const cached = this.#agents.get(id);
        if (cached)
            return cached;
        let value;
        try {
            value = record(JSON.parse(await readFile(this.#agentFile(id), "utf8")));
        }
        catch (error) {
            if (error.code === "ENOENT")
                throw new BrokerError("agent_not_found", `Unknown DSH worker ${id}`);
            throw error;
        }
        if (value.id !== id || typeof value.homeId !== "string" || !SESSION_ID.test(value.homeId) ||
            typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) {
            throw new BrokerError("invalid_agent", "Invalid persisted DSH worker");
        }
        const hit = this.#agents.get(id);
        if (hit)
            return hit;
        const cursor = Number.isSafeInteger(value.cursor) ? Number(value.cursor) : 0;
        const status = value.status === "completed" || value.status === "interrupted" ? value.status : "failed";
        const agent = { id, homeId: value.homeId, cwd: value.cwd, status, cursor, droppedThrough: cursor, events: [], outputChars: 0,
            output: typeof value.output === "string" ? value.output.slice(-MAX_OUTPUT) : "",
            ...(status === "failed" ? { error: typeof value.error === "string" ? value.error : "DSH worker disconnected during a turn. Resume with an explicit follow-up." } : {}),
        };
        this.#agents.set(id, agent);
        return agent;
    }
    #agentFile(id) { return path.join(this.directory, "agents", `${id}.json`); }
    #persist(agent, status = agent.status, cursor = agent.cursor) {
        const { id, homeId, cwd, output, error } = agent;
        return this.#write(this.#agentFile(id), JSON.stringify({ id, homeId, cwd, status, cursor, output, error }));
    }
    async #write(file, contents) {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, contents, { mode: 0o600 });
        await rename(temporary, file);
    }
}
class WorkerConnection {
    peer;
    exited;
    #child;
    #secrets;
    #closed;
    #cancelTimer;
    sessionId;
    active = false;
    constructor(binary, cwd, env, patch, writablePaths, access) {
        const command = process.platform === "win32" && binary.toLowerCase() === "dsh" ? "dsh.cmd" : binary;
        const spec = resolveCodexProcess(command, env);
        const invocation = buildProcessInvocation(spec, ["--profile", "acp", "--patch", patch]);
        let commandPath = invocation.command;
        let args = invocation.args;
        if (process.platform === "linux") {
            args = [
                "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
                ...writablePaths.flatMap(root => ["--bind", root, root]),
                "--chdir", cwd, "--", commandPath, ...args,
            ];
            commandPath = "bwrap";
        }
        else if (process.platform === "darwin") {
            const roots = writablePaths.map(root => `(subpath ${JSON.stringify(root)})`).join(" ");
            args = ["-p", `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null") ${roots})`,
                "--", commandPath, ...args];
            commandPath = "/usr/bin/sandbox-exec";
        }
        else if (access === "workspace-write") {
            throw new BrokerError("unsupported_access", "Writable DSH Broker workers require Linux Bubblewrap or macOS sandbox-exec");
        }
        this.#child = spawn(commandPath, args, {
            cwd, env, stdio: "pipe", windowsVerbatimArguments: invocation.windowsVerbatimArguments, windowsHide: true,
        });
        this.#secrets = Object.entries(env).flatMap(([name, value]) => name.startsWith("DSH_BROKER_SECRET_") && value ? [value] : []);
        this.peer = new JsonLinePeer(this.#child.stdout, this.#child.stdin, "dsh-broker");
        this.peer.setRequestHandler(async (method) => {
            if (method !== "session/request_permission")
                throw new Error(`Unsupported ACP request ${method}`);
            return { outcome: { outcome: "cancelled" } };
        });
        let stderr = "";
        this.#child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2_000); });
        this.exited = new Promise(resolve => this.#child.once("close", () => {
            this.peer.close(new Error(this.redact(stderr.trim()) || "DSH worker process exited"));
            resolve();
        }));
        this.#child.on("error", error => this.peer.close(error));
        this.peer.start();
    }
    redact(text) {
        return this.#secrets.reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), text);
    }
    safeError(error) {
        const details = error instanceof JsonRpcRemoteError ? record(error.data).details : undefined;
        return this.redact(typeof details === "string" ? details : errorMessage(error)).slice(0, 4_000);
    }
    cancel() {
        if (this.sessionId)
            this.peer.notify("session/cancel", { sessionId: this.sessionId });
        this.#cancelTimer ??= setTimeout(() => this.#child.kill("SIGKILL"), STOP_GRACE);
    }
    close() {
        return this.#closed ??= (async () => {
            try {
                if (this.sessionId)
                    await this.peer.request("session/close", { sessionId: this.sessionId }, STOP_GRACE);
            }
            catch { /* Ending stdio also releases the DSH session lease. */ }
            finally {
                this.#child.stdin.end();
                const timer = setTimeout(() => this.#child.kill("SIGKILL"), STOP_GRACE);
                await this.exited;
                clearTimeout(timer);
                clearTimeout(this.#cancelTimer);
            }
        })();
    }
}
