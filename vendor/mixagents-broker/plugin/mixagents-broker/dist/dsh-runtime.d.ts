import { EventEmitter } from "node:events";
import type { AgentEventsResult, AgentSnapshot, RuntimeMetadata } from "./types.js";
export declare class DshRuntime extends EventEmitter {
    #private;
    private readonly metadata;
    private readonly directory;
    private readonly environment;
    revision: number;
    constructor(metadata: RuntimeMetadata, directory: string, environment: NodeJS.ProcessEnv);
    startAgent(task: string, cwd: string): Promise<AgentSnapshot>;
    send(id: string, task: string): Promise<AgentSnapshot>;
    snapshotFor(id: string): Promise<AgentSnapshot>;
    takeInteraction(): undefined;
    interrupt(id: string): Promise<{
        previousStatus: import("./types.js").AgentStatus;
        agent: AgentSnapshot;
    }>;
    listThreads(): Promise<Array<{
        id: string;
    }>>;
    readEvents(id: string, cursor: number, maxEvents: number, waitMs: number, signal?: AbortSignal): Promise<AgentEventsResult>;
    stop(): Promise<void>;
}
