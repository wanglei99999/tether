import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAppStore, registerAppStoreConformance } from "../src/index.ts";

registerAppStoreConformance({ describe, it, expect, beforeEach }, "memory", async () => ({
	store: new MemoryAppStore(),
	close: async () => {},
}));
