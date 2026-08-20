import { normalizeRelation, type INormalizedRelation } from "../app/graphNormalization.js";
import { detectConflicts, summarizeConflict } from "../app/conflictDetector.js";
import { decideFeedback } from "../app/feedbackEngine.js";

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

console.log("\n===== CONFLICT =====");
console.dir(analysis, { depth: null });

for (const finding of analysis.findings) {
    console.log("\n===== CONFLICT SUMMARY =====");

    for (const line of summarizeConflict(finding)) {
        console.log(line);
    }

    const feedback = decideFeedback(finding);

    console.log("\n===== FEEDBACK =====");
    console.dir(feedback, { depth: null });
}