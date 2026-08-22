/**
 * FINAL END-TO-END MEMORY TEST
 *
 * Cycle 1:
 *   Ravi does not like coffee.
 *        ↓
 *   DISLIKES(coffee) written to Neo4j
 *
 * Cycle 2:
 *   Ravi now likes coffee.
 *        ↓
 *   LIKES(coffee) written to Neo4j
 *        ↓
 *   historical DISLIKES(coffee) retrieved
 *        ↓
 *   ConflictDetector
 *        ↓
 *   FeedbackEngine → SUPERSEDED
 *        ↓
 *   SelfCorrectionEngine
 *        ↓
 *   DISLIKES edge deleted
 *
 * Final:
 *   Neo4j contains LIKES(coffee)
 *   Neo4j does NOT contain DISLIKES(coffee)
 */

import { Memory } from "../app/memory.js";
import {
    BackgroundMemoryProcessor,
} from "../app/backgroundMemoryProcessor.js";

import type {
    IMemoryExtraction,
} from "../app/memoryExtraction.js";

import {
    Neo4jMemoryStore,
} from "../app/graphStore.js";

import {
    ContextWatcher,
    defaultTopicAnalyzer,
} from "../app/contextWatcher.js";

import {
    GraphKnowledgeRetriever,
} from "../app/graphRetrieval.js";

import {
    SelfCorrectionEngine,
} from "../app/selfCorrection.js";

import "dotenv/config";
// ============================================================
// CYCLE 1 EXTRACTION
// ============================================================

const cycle1Extraction: IMemoryExtraction = {
    summary: "Ravi discussed his beverage preferences.",

    facts: [
        "Ravi does not like coffee.",
        "Ravi prefers tea.",
    ],

    relations: [
        {
            subject: "Ravi",
            predicate: "dislikes",
            object: "Coffee",
            confidence: 0.95,
        },
        {
            subject: "Ravi",
            predicate: "prefers",
            object: "Tea",
            confidence: 0.90,
        },
    ],

    feedback: [
        {
            type: "preference",
            text: "Ravi prefers tea over coffee.",
        },
    ],

    extractedAt: new Date().toString(),
};


// ============================================================
// CYCLE 2 EXTRACTION
// ============================================================

const cycle2Extraction: IMemoryExtraction = {
    summary: "Ravi changed his preference and now likes coffee.",

    facts: [
        "Ravi now likes coffee.",
    ],

    relations: [
        {
            subject: "Ravi",
            predicate: "likes",
            object: "Coffee",
            confidence: 0.95,
        },
    ],

    feedback: [
        {
            type: "preference",
            text: "Ravi now likes coffee.",
        },
    ],

    extractedAt: new Date().toString(),
};


// ============================================================
// DETERMINISTIC EXTRACTOR
// ============================================================
//
// We deliberately do NOT call an LLM here.
// The purpose of this final test is to test:
//
// Memory
// → BackgroundMemoryProcessor
// → Graph write
// → Graph retrieval
// → Conflict detection
// → Feedback
// → Self correction
// → Neo4j final state
//
// The extraction itself was already tested separately.
// ============================================================

let extractionRun = 0;

const extractor = {
    async extract(
        messages: readonly unknown[],
    ): Promise<IMemoryExtraction> {

        extractionRun++;

        console.log(
            `\nEXTRACTOR RUN #${extractionRun}`,
        );

        console.log(
            "Messages:",
            messages,
        );

        if (extractionRun === 1) {
            console.log(
                "Returning CYCLE 1 extraction: DISLIKES coffee",
            );

            return cycle1Extraction;
        }

        if (extractionRun === 2) {
            console.log(
                "Returning CYCLE 2 extraction: LIKES coffee",
            );

            return cycle2Extraction;
        }

        throw new Error(
            `Unexpected extractor run: ${extractionRun}`,
        );
    },
};


// ============================================================
// REAL MEMORY
// ============================================================

const memory = new Memory();


// ============================================================
// REAL NEO4J STORE
// ============================================================
if (
    !process.env.NEO4J_URI ||
    !process.env.NEO4J_USER ||
    !process.env.NEO4J_PASSWORD
) {
    throw new Error(
        "Missing required Neo4j environment variables.",
    );
}

const store = new Neo4jMemoryStore({
    uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USER,
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || "neo4j",
});

await store.initialize();


// ============================================================
// REAL GRAPH RETRIEVER
// ============================================================

const retriever = new GraphKnowledgeRetriever({
    run: async (query, params) => {
        return store.runQuery(query, params);
    },
});


// ============================================================
// REAL SELF-CORRECTION ENGINE
// ============================================================

const selfCorrection = new SelfCorrectionEngine({
    run: async (query, params) => {
        return store.runQuery(query, params);
    },
});


// ============================================================
// REAL CONTEXT WATCHER
// ============================================================

const watcher = new ContextWatcher({
    memory,
    analyzer: defaultTopicAnalyzer,
    retriever: async topic => {
        return retriever.retrieve(topic);
    },
});


// ============================================================
// REAL BACKGROUND MEMORY PROCESSOR
// ============================================================

const processor = new BackgroundMemoryProcessor({
    memory,
    extractor,
    store,
    watcher,

    // Explicitly provide the real components so this test
    // makes the complete architecture visible.
    retriever: async topic => {
        return retriever.retrieve(topic);
    },

    selfCorrection,
});


// ============================================================
// HELPERS
// ============================================================

async function queryCoffeeRelations() {

    const result = await store.runQuery(
        `
        MATCH (u:Entity {name: "ravi"})
              -[r:RELATES_TO]->
              (e:Entity {name: "coffee"})
        RETURN
            u.name AS subject,
            r.predicate AS predicate,
            e.name AS object
        ORDER BY r.predicate
        `,
    );

    return result.records.map(record => ({
        subject: record.get("subject"),
        predicate: record.get("predicate"),
        object: record.get("object"),
    }));
}


async function clearCoffeeRelations() {

    await store.runQuery(
        `
        MATCH (u:Entity {name: "ravi"})
              -[r:RELATES_TO]->
              (e:Entity {name: "coffee"})
        DELETE r
        `,
    );
}


function printRelations(
    title: string,
    relations: readonly {
        subject: unknown;
        predicate: unknown;
        object: unknown;
    }[],
) {

    console.log(`\n===== ${title} =====`);

    if (relations.length === 0) {
        console.log("No relations found.");
        return;
    }

    for (const relation of relations) {
        console.log(
            `${relation.subject} ${relation.predicate} ${relation.object}`,
        );
    }
}


// ============================================================
// TEST
// ============================================================

async function main() {

    console.log(
        "\n==================================================",
    );

    console.log(
        "FINAL MEMORY END-TO-END TEST",
    );

    console.log(
        "==================================================",
    );


    // --------------------------------------------------------
    // CLEAN START
    // --------------------------------------------------------

    console.log(
        "\n===== CLEANING PREVIOUS COFFEE RELATIONS =====",
    );

    await clearCoffeeRelations();


    // --------------------------------------------------------
    // CYCLE 1
    // --------------------------------------------------------

    console.log(
        "\n========================================",
    );

    console.log(
        "CYCLE 1 — INITIAL KNOWLEDGE",
    );

    console.log(
        "========================================",
    );


    memory.addUser(
        "I don't like coffee.",
    );


    await processor.process();


    const afterCycle1 =
        await queryCoffeeRelations();


    printRelations(
        "GRAPH AFTER CYCLE 1",
        afterCycle1,
    );


    // Expected:
    //
    // ravi DISLIKES coffee
    //
    // There should be no LIKES yet.


    // --------------------------------------------------------
    // CYCLE 1 ASSERTIONS
    // --------------------------------------------------------

    const cycle1Dislikes =
        afterCycle1.some(
            relation =>
                relation.subject === "ravi" &&
                relation.predicate === "DISLIKES" &&
                relation.object === "coffee",
        );


    if (!cycle1Dislikes) {
        throw new Error(
            "CYCLE 1 FAILED: DISLIKES coffee was not written to Neo4j.",
        );
    }


    console.log(
        "\nCYCLE 1 RESULT: PASS",
    );


    // --------------------------------------------------------
    // CYCLE 2
    // --------------------------------------------------------

    console.log(
        "\n========================================",
    );

    console.log(
        "CYCLE 2 — USER CHANGES PREFERENCE",
    );

    console.log(
        "========================================",
    );


    memory.addUser(
        "Actually, I like coffee now.",
    );


    await processor.process();


    // --------------------------------------------------------
    // PROCESSOR RESULTS
    // --------------------------------------------------------

    console.log(
        "\n===== PROCESSOR STATE =====",
    );

    console.dir(
        processor.getProcessingState(),
        {
            depth: null,
        },
    );


    console.log(
        "\n===== LATEST EXTRACTION =====",
    );

    console.dir(
        processor.getLatestExtraction(),
        {
            depth: null,
        },
    );


    console.log(
        "\n===== LATEST FEEDBACK =====",
    );

    console.dir(
        processor.getLatestFeedback(),
        {
            depth: null,
        },
    );


    console.log(
        "\n===== LATEST CORRECTIONS =====",
    );

    console.dir(
        processor.getLatestCorrections(),
        {
            depth: null,
        },
    );


    // --------------------------------------------------------
    // GRAPH AFTER SELF CORRECTION
    // --------------------------------------------------------

    const afterCycle2 =
        await queryCoffeeRelations();


    printRelations(
        "GRAPH AFTER CYCLE 2 + SELF CORRECTION",
        afterCycle2,
    );


    // --------------------------------------------------------
    // CYCLE 2 ASSERTIONS
    // --------------------------------------------------------

    const cycle2Likes =
        afterCycle2.some(
            relation =>
                relation.subject === "ravi" &&
                relation.predicate === "LIKES" &&
                relation.object === "coffee",
        );


    const cycle2Dislikes =
        afterCycle2.some(
            relation =>
                relation.subject === "ravi" &&
                relation.predicate === "DISLIKES" &&
                relation.object === "coffee",
        );


    if (!cycle2Likes) {
        throw new Error(
            "CYCLE 2 FAILED: LIKES coffee was not found in Neo4j.",
        );
    }


    if (cycle2Dislikes) {
        throw new Error(
            "CYCLE 2 FAILED: DISLIKES coffee still exists after self-correction.",
        );
    }


    console.log(
        "\nCYCLE 2 RESULT: PASS",
    );


    // --------------------------------------------------------
    // VERIFY FEEDBACK
    // --------------------------------------------------------

    const feedback =
        processor.getLatestFeedback();


    console.log(
        "\n===== FEEDBACK ASSERTION =====",
    );


    if (!feedback || feedback.length === 0) {
        throw new Error(
            "FEEDBACK FAILED: No feedback was generated.",
        );
    }


    const superseded =
        feedback.some(
            item =>
                item.action === "SUPERSEDED",
        );


    if (!superseded) {
        throw new Error(
            "FEEDBACK FAILED: Expected SUPERSEDED action.",
        );
    }


    console.log(
        "Feedback action: SUPERSEDED",
    );

    console.log(
        "FEEDBACK RESULT: PASS",
    );


    // --------------------------------------------------------
    // VERIFY SELF CORRECTION
    // --------------------------------------------------------

   // --------------------------------------------------------
// VERIFY SELF CORRECTION
// --------------------------------------------------------

const correctionReport =
    processor.getLatestCorrections();

console.log(
    "\n===== SELF CORRECTION ASSERTION =====",
);

console.dir(
    correctionReport,
    {
        depth: null,
    },
);

if (!correctionReport) {
    throw new Error(
        "SELF CORRECTION FAILED: No correction report was generated.",
    );
}

if (
    correctionReport.corrections.length === 0
) {
    throw new Error(
        "SELF CORRECTION FAILED: No correction was generated.",
    );
}

const supersedeRule =
    correctionReport.corrections.some(
        correction =>
            correction.rule === "RULE_SUPERSEDE",
    );

if (!supersedeRule) {
    throw new Error(
        "SELF CORRECTION FAILED: RULE_SUPERSEDE was not executed.",
    );
}

console.log(
    "Correction count:",
    correctionReport.corrections.length,
);

console.log(
    "Mutations applied:",
    correctionReport.mutationsApplied,
);

console.log(
    "Rule: RULE_SUPERSEDE",
);

console.log(
    "SELF CORRECTION RESULT: PASS",
);


    // --------------------------------------------------------
    // CONTEXT WATCHER
    // --------------------------------------------------------

    console.log(
        "\n========================================",
    );

    console.log(
        "FINAL CONTEXT RETRIEVAL",
    );

    console.log(
        "========================================",
    );


    const topic =
        watcher.getCurrentTopic();


    console.log(
        "\nCURRENT TOPIC:",
    );

    console.dir(
        topic,
        {
            depth: null,
        },
    );


    if (!topic) {
        throw new Error(
            "CONTEXT FAILED: No current topic was detected.",
        );
    }


    const knowledge =
        await retriever.retrieve(topic);


    console.log(
        "\nFINAL GRAPH KNOWLEDGE:",
    );

    console.dir(
        knowledge,
        {
            depth: null,
        },
    );


    // --------------------------------------------------------
    // FINAL CONTEXT ASSERTIONS
    // --------------------------------------------------------

    const finalLikes =
        knowledge.relations.some(
            relation =>
                relation.subject === "ravi" &&
                relation.predicate === "LIKES" &&
                relation.object === "coffee",
        );


    const finalDislikes =
        knowledge.relations.some(
            relation =>
                relation.subject === "ravi" &&
                relation.predicate === "DISLIKES" &&
                relation.object === "coffee",
        );


    if (!finalLikes) {
        throw new Error(
            "FINAL CONTEXT FAILED: LIKES coffee was not retrieved.",
        );
    }


    if (finalDislikes) {
        throw new Error(
            "FINAL CONTEXT FAILED: DISLIKES coffee was retrieved after correction.",
        );
    }


    console.log(
        "\nFINAL CONTEXT RESULT: PASS",
    );


    // --------------------------------------------------------
    // FINAL RESULT
    // --------------------------------------------------------

    console.log(
        "\n==================================================",
    );

    console.log(
        "FINAL END-TO-END RESULT: PASS",
    );

    console.log(
        "==================================================",
    );

    console.log(
        `
Memory
  ↓
BackgroundMemoryProcessor
  ↓
Cycle 1: DISLIKES coffee
  ↓
Neo4j
  ↓
Cycle 2: LIKES coffee
  ↓
Historical retrieval
  ↓
ConflictDetector
  ↓
FeedbackEngine → SUPERSEDED
  ↓
SelfCorrectionEngine → RULE_SUPERSEDE
  ↓
DISLIKES deleted
  ↓
ContextWatcher
  ↓
Final knowledge: ravi LIKES coffee
`,
    );
}


main()
    .catch(error => {
        console.error(
            "\n===== FINAL E2E TEST FAILED =====",
        );

        console.error(error);

        process.exitCode = 1;
    });

// npm exec tsx src/tests/final-memory-e2e-test.ts