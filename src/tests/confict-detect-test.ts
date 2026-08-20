import{detectConflicts, summarizeConflict} from "../app/conflictDetector.js"
import { normalizeRelation } from "../app/graphNormalization.js";
import type { IRetrievedRelation } from '../app/graphRetrieval.js';
import type { INormalizedRelation } from "../app/graphNormalization.js"

// const current = [
//     normalizeRelation({
//         subject: "ravi",
//         predicate: "LIKES",
//         object: "coffee",
//         confidence: 0.95,
//     }),
// ] as INormalizedRelation[];

// const historical = [
//     {
//         subject: "ravi",
//         predicate: "DISLIKES",
//         object: "coffee",
//         confidence: 0.90,
//     },
// ];

// const result = detectConflicts({
//     current,
//     historical,
//     evidence: [
//         "I love coffee.",
//     ],
// });

// console.dir(result, { depth: null });

// for (const finding of result.findings) {
//     console.log("\n===== SUMMARY =====");

//     for (const line of summarizeConflict(finding)) {
//         console.log(line);
//     }
// }


const result = detectConflicts({
    current: [
        {
            subject: "ravi",
            predicate: "LIKES",
            object: "tea",
            confidence: 0.95,
        },
    ] as INormalizedRelation [],

    historical: [
        {
            subject: "ravi",
            predicate: "DISLIKES",
            object: "tea",
            confidence: 0.90,
        },
    ],

    evidence: [
        "I really like tea.",
    ],
});

console.dir(result, { depth: null });