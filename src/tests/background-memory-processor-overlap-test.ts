import { Memory } from "../app/memory.js";
import { BackgroundMemoryProcessor } from "../app/backgroundMemoryProcessor.js";

const memory = new Memory();

let extractionCount = 0;

const extractor = {
    async extract(messages: readonly any[]) {
        extractionCount++;

        console.log(
            `EXTRACTOR START #${extractionCount}`,
            messages.map(message => message.id),
        );

        // Simulate a slow background process.
        await new Promise(resolve => setTimeout(resolve, 200));

        console.log(
            `EXTRACTOR END #${extractionCount}`,
        );

        return {
            summary: "Slow test extraction",
            facts: [],
            relations: [],
            feedback: [],
            extractedAt: new Date().toISOString(),
        };
    },
};

const store = {
    async saveExtraction() {
        console.log("GRAPH SAVE");
    },
};

const watcher = {
    async tick() {
        console.log("WATCHER TICK");
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

memory.addUser("Message one.");

console.log("\n===== START OVERLAPPING PROCESSES =====");

const first = processor.process();

console.log(
    "After first call, isRunning:",
    processor.isRunning,
);

const second = processor.process();

console.log(
    "After second call, isRunning:",
    processor.isRunning,
);

await Promise.all([
    first,
    second,
]);

console.log("\n===== RESULT =====");

console.log(
    "Extraction count:",
    extractionCount,
);

console.log(
    "Processor running:",
    processor.isRunning,
);

console.log("\n===== EXPECTED =====");

console.log(
    "Extraction count should be: 1",
);

console.log(
    "Processor running should be: false",
);