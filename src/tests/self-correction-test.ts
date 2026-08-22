import { normalizeRelation } from "../app/graphNormalization.js";
import { detectConflicts } from "../app/conflictDetector.js";
import type { INormalizedRelation } from "../app/graphNormalization.js"
import {
    SelfCorrectionEngine,
} from "../app/selfCorrection.js";

const queries: {
    query: string
    params?: Record<string, unknown>
}[] = []

const fakeRunner = {
    async run(
        query: string,
        params?: Record<string, unknown>,
    ) {
        if(params === undefined){
            queries.push({ query });            
        }else{
            queries.push({ query, params });

        }

        return {
            records: [],
        };
    },
};

const engine = new SelfCorrectionEngine(fakeRunner);

const current = [
    normalizeRelation({
        subject: "ravi",
        predicate: "LIKES",
        object: "coffee",
        confidence: 0.95,
    }),
] as INormalizedRelation[];

const historical = [
    {
        subject: "ravi",
        predicate: "DISLIKES",
        object: "coffee",
        confidence: 0.90,
    },
];

const analysis = detectConflicts({
    current,
    historical,
    evidence: [
        "I love coffee.",
    ],
});

console.log("\n===== CONFLICT ANALYSIS =====");
console.dir(analysis, { depth: null });

const report = await engine.applyCorrections(
    analysis.findings,
);

console.log("\n===== SELF CORRECTION REPORT =====");
console.dir(report, { depth: null });

console.log("\n===== CYPHER EXECUTED =====");
console.dir(queries, { depth: null });


// npm exec tsx src/tests/self-correction-test.ts