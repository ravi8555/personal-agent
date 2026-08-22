import { Memory } from "../app/memory.js";
import { BackgroundMemoryProcessor } from "../app/backgroundMemoryProcessor.js";

const memory = new Memory();

let extractionCount = 0;
let saveCount = 0;
let watcherTickCount = 0;
let retrievalCount = 0;
let correctionCount = 0;

const processedBatches: string[][] = [];

const extractor = {
    async extract(messages: readonly any[]) {
        extractionCount++;

        const ids = messages.map(message => message.id);
        processedBatches.push(ids);

        console.log(
            `\nEXTRACTOR RUN #${extractionCount}`,
        );

        console.log(
            "Messages:",
            ids,
        );

        return {
            summary: `Processed ${messages.length} message(s).`,
            facts: [],
            relations: [],
            feedback: [],
            extractedAt: new Date().toISOString(),
        };
    },
};

const store = {
    async saveExtraction() {
        saveCount++;

        console.log(
            `GRAPH SAVE #${saveCount}`,
        );
    },
};

const watcher = {
    async tick() {
        watcherTickCount++;

        console.log(
            `WATCHER TICK #${watcherTickCount}`,
        );
    },

    getCurrentTopic() {
        return {
            topic: "test",
            key: "test",
            evidence: [],
            observedAt: new Date().toISOString(),
        };
    },

    getProcessor() {
        return undefined;
    },
};

const retriever = async () => {
    retrievalCount++;

    return {
        topicKey: "test",
        topicLabel: "Test",
        entityFound: false,
        relations: [],
        facts: [],
        feedback: [],
        summaries: [],
    };
};

const selfCorrection = {
    async applyCorrections() {
        correctionCount++;

        return {
            corrections: [],
            mutationsApplied: 0,
            text: "[Self-correction] No conflicts to correct.",
        };
    },
};

const processor = new BackgroundMemoryProcessor({
    memory,
    extractor,
    store: store as any,
    watcher: watcher as any,
    retriever: retriever as any,
    selfCorrection: selfCorrection as any,
});

console.log("\n========================================");
console.log("TEST 1 — FIRST PROCESSING");
console.log("========================================");

memory.addUser("Message one.");
memory.addAssistant("Message two.");
memory.addUser("Message three.");

await processor.process();

console.log("\nPROCESSING STATE:");
console.dir(processor.getProcessingState());

console.log("\nLATEST EXTRACTION:");
console.dir(processor.getLatestExtraction());

console.log("\n========================================");
console.log("TEST 2 — ONLY NEW MESSAGES");
console.log("========================================");

memory.addUser("Message four.");
memory.addAssistant("Message five.");

await processor.process();

console.log("\nPROCESSING STATE:");
console.dir(processor.getProcessingState());

console.log("\n========================================");
console.log("TEST 3 — NO NEW MESSAGES");
console.log("========================================");

await processor.process();

console.log("\nPROCESSING STATE:");
console.dir(processor.getProcessingState());

console.log("\n========================================");
console.log("TEST 4 — SUMMARY");
console.log("========================================");

console.log(
    "Extraction count:",
    extractionCount,
);

console.log(
    "Graph save count:",
    saveCount,
);

console.log(
    "Watcher tick count:",
    watcherTickCount,
);

console.log(
    "Retrieval count:",
    retrievalCount,
);

console.log(
    "Correction count:",
    correctionCount,
);

console.log(
    "Processed batches:",
    processedBatches,
);

console.log(
    "Processor running:",
    processor.isRunning,
);